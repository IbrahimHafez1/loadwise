'use strict';

// Helpers shared by the request-forgery rules: argument and option lookup, response receivers, hop tiering, and the
// validation evidence that keeps a traced value quiet.
const { syntax: ts } = require('../../performance/compiler.cjs');

const secondHopReason = 'Reached through two calls; confirm the intermediate functions do not validate the value.';
// Parameter names that hold an HTTP response (Express, Fastify, Koa, Hono) in practice.
const responseNames = new Set(['res', 'response', 'reply', 'ctx', 'context', 'c']);
// Response methods that return the response, so a chain through them still ends on it.
const chainedResponseMethods = new Set(['status', 'code', 'type', 'set', 'header', 'cookie', 'clearCookie']);
// Methods whose call on, or with, a value is a containment, prefix or allowlist check.
const guardMethods = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'has', 'test', 'match', 'relative']);
// Project helpers named like validators: `assertSafePath(p)`, `isAllowedHost(u.hostname)`, `validateUrl(url)`.
const validatorName =
  /valid|allow|safe|trust|whitelist|permit|verify|assert|ensure|sanitiz|check|is(?:Internal|Private|Local|Relative|Absolute|Url|URL)|inside|within|contain/i;
const nullishLiterals = new Set([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.UndefinedKeyword]);
// Trace labels for the Host header: `req.headers.host`, `req.hostname`, `req.get('host')`, `@Headers('host') host`.
const hostHeaderLabel =
  /(?:headers?\W+(?:x-forwarded-)?host\b|\b(?:req|request|ctx)\.host(?:name)?\b|\.(?:get|header)\(['"`](?:x-forwarded-)?host['"`]|@HostParam)/i;
// Variables followed forward or backward when collecting the names a guard may test.
const maxRelatedRounds = 4;

function strip(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current))
  )
    current = current.expression;
  return current;
}

function nameText(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

// The value of property `name` in an object literal argument, for `{ url }` and `{ url: target }`.
function propertyValue(argument, name) {
  const literal = strip(argument);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && nameText(property.name) === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
}

function hasProperty(argument, name) {
  const literal = strip(argument);
  return Boolean(
    literal &&
    ts.isObjectLiteralExpression(literal) &&
    literal.properties.some((property) => !ts.isSpreadAssignment(property) && nameText(property.name) === name),
  );
}

function calleeName(call) {
  const callee = strip(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// `res.redirect(...)`: the receiver is an identifier named like a response, or `this.res`, possibly through
// chained setters such as `res.status(302).redirect(...)`.
function isResponseReceiver(expression) {
  let receiver = strip(expression);
  while (
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    chainedResponseMethods.has(receiver.expression.name.text)
  )
    receiver = strip(receiver.expression.expression);
  if (ts.isIdentifier(receiver)) return responseNames.has(receiver.text);
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
    responseNames.has(receiver.name.text)
  );
}

// An identifier that is not declared by the project: a global such as `fetch` or `Response`.
function isGlobalIdentifier(identifier, checker) {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  return !declaration || declaration.getSourceFile().isDeclarationFile;
}

function isHostHeader(trace) {
  return hostHeaderLabel.test(trace.label);
}

function hopReason(trace) {
  return trace.hops >= 2 ? secondHopReason : undefined;
}

function constantDeclaration(identifier, checker) {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
  return declaration.parent.flags & ts.NodeFlags.Const ? declaration : undefined;
}

// Identifiers and property chains (`target`, `req.query.next`) inside `expression` that carry request data.
function taintedKeys(expression, isTainted) {
  const keys = new Set();
  (function visit(node) {
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (isTainted(node)) {
        keys.add(node.getText());
        return;
      }
    }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  })(expression);
  return keys;
}

function mentions(node, keys) {
  let found = false;
  (function visit(child) {
    if (found) return;
    if (
      (ts.isIdentifier(child) || ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) &&
      keys.has(child.getText())
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  })(node);
  return found;
}

function outermostFunction(node) {
  let outer;
  for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) outer = current;
  return outer;
}

// Names a guard may test for the sink value: its tainted parts, the constants they were read from, and variables
// derived from them in the same function (`const url = new URL(target)`, `const full = path.resolve(root, name)`).
function relatedKeys(expression, scope, isTainted, checker) {
  const keys = taintedKeys(expression, isTainted);
  const declarations = [];
  (function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push(node);
    ts.forEachChild(node, collect);
  })(scope);
  for (let round = 0; round < maxRelatedRounds; round++) {
    const before = keys.size;
    for (const key of keys) {
      const declaration = declarations.find((candidate) => candidate.name.getText() === key);
      if (declaration && ts.isIdentifier(declaration.name) && constantDeclaration(declaration.name, checker))
        for (const inner of taintedKeys(declaration.initializer, isTainted)) keys.add(inner);
    }
    for (const declaration of declarations)
      if (ts.isIdentifier(declaration.name) && mentions(declaration.initializer, keys)) keys.add(declaration.name.text);
    if (keys.size === before) break;
  }
  return keys;
}

function isNullishOrEmpty(node) {
  const value = strip(node);
  return (
    nullishLiterals.has(value.kind) ||
    (ts.isIdentifier(value) && value.text === 'undefined') ||
    (ts.isStringLiteralLike(value) && value.text === '')
  );
}

// `x === allowed`, `u.hostname !== 'api.example.com'`; not `typeof x === 'string'` or `x !== undefined`.
function isComparisonGuard(node, keys) {
  const operator = node.operatorToken.kind;
  if (
    operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    operator !== ts.SyntaxKind.EqualsEqualsToken &&
    operator !== ts.SyntaxKind.ExclamationEqualsToken
  )
    return false;
  const sides = [node.left, node.right].map(strip);
  if (sides.some((side) => ts.isTypeOfExpression(side) || isNullishOrEmpty(side))) return false;
  return sides.some((side) => mentions(side, keys));
}

function isGuardCall(call, keys, sink, ignoredMethods) {
  if (call === sink) return false;
  const name = calleeName(call);
  if (!name) return false;
  if (ignoredMethods?.has(name)) return false;
  const callee = strip(call.expression);
  const receiverMentions = ts.isPropertyAccessExpression(callee) && mentions(callee.expression, keys);
  const argumentMentions = call.arguments.some((argument) => mentions(argument, keys));
  if (guardMethods.has(name) || name === 'isAbsolute') return receiverMentions || argumentMentions;
  return validatorName.test(name) && argumentMentions;
}

function containsGuard(body, keys, sink, ignoredMethods) {
  let guarded = false;
  (function visit(node) {
    if (guarded) return;
    if (ts.isCallExpression(node) && isGuardCall(node, keys, sink, ignoredMethods)) guarded = true;
    else if (ts.isBinaryExpression(node) && isComparisonGuard(node, keys)) guarded = true;
    else if (ts.isSwitchStatement(node) && mentions(node.expression, keys)) guarded = true;
    ts.forEachChild(node, visit);
  })(body);
  return guarded;
}

// A project-local helper the value is passed to, such as `const full = this.resolveSafePath(name)`, that checks
// the matching parameter itself. One level deep.
function guardedInHelper(scope, keys, sink, checker, ignoredMethods) {
  let guarded = false;
  (function visit(node) {
    if (guarded) return;
    if (ts.isCallExpression(node) && node !== sink) {
      const helper = checker.getResolvedSignature(node)?.declaration;
      if (
        helper &&
        ts.isFunctionLike(helper) &&
        helper.body &&
        helper !== scope &&
        !helper.getSourceFile().isDeclarationFile
      ) {
        const parameterKeys = new Set();
        node.arguments.forEach((argument, index) => {
          const parameter = helper.parameters[index];
          if (parameter && ts.isIdentifier(parameter.name) && mentions(argument, keys))
            parameterKeys.add(parameter.name.text);
        });
        if (parameterKeys.size && containsGuard(helper.body, parameterKeys, sink, ignoredMethods)) guarded = true;
      }
    }
    ts.forEachChild(node, visit);
  })(scope.body);
  return guarded;
}

// True when the function around `sink` (or an enclosing one, or a local helper the value passes through) checks the
// traced value: a prefix, containment or allowlist test, an equality against a known value, or a call to a
// validator-named helper. Flow-insensitive on purpose: a check anywhere near the sink is taken as intent, trading
// recall for precision. `ignoredMethods` names guard methods a rule does not count.
function hasValidationEvidence(sink, expression, isTainted, checker, ignoredMethods) {
  const scope = outermostFunction(sink);
  if (!scope?.body) return false;
  const keys = relatedKeys(expression, scope, isTainted, checker);
  if (!keys.size) return false;
  return (
    containsGuard(scope.body, keys, sink, ignoredMethods) || guardedInHelper(scope, keys, sink, checker, ignoredMethods)
  );
}

module.exports = {
  strip,
  nameText,
  propertyValue,
  hasProperty,
  calleeName,
  isResponseReceiver,
  isGlobalIdentifier,
  hopReason,
  isHostHeader,
  constantDeclaration,
  hasValidationEvidence,
};
