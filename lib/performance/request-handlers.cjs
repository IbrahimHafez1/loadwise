'use strict';

// Shared by the rules that only matter when the work happens for a request: which function is a request handler,
// and whether a value ends up in its response.
const { syntax: ts } = require('./compiler.cjs');

const ROUTE_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'All',
  'Head',
  'Options',
  'Query',
  'Mutation',
  'ResolveField',
]);
const HTTP_VERB_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const REQUEST_PARAMETER = /^req(?:uest)?$/;
const RESPONSE_PARAMETER = /^(?:res|response|reply|h)$/;
const RESPONSE_RECEIVER = /^(?:res|response|reply|ctx|NextResponse|Response)$/;
const RESPONSE_METHODS = new Set(['json', 'send', 'jsonp']);
// Reading these off a result takes one element or a count, so the full list never reaches the response.
const NARROWING_MEMBERS = new Set(['length', 'slice', 'splice', 'at', 'find', 'findIndex', 'some', 'every']);
const SIZE_PRESERVING_METHODS = new Set(['map', 'filter', 'sort', 'toSorted', 'reverse', 'flatMap']);
const TRANSPARENT_KINDS = [
  'isParenthesizedExpression',
  'isAwaitExpression',
  'isAsExpression',
  'isNonNullExpression',
  'isSatisfiesExpression',
  'isObjectLiteralExpression',
  'isPropertyAssignment',
  'isShorthandPropertyAssignment',
  'isArrayLiteralExpression',
  'isSpreadElement',
  'isSpreadAssignment',
];
const MAX_ALIAS_DEPTH = 3;

function hasDecoratorNamed(node, names) {
  return !!node.modifiers?.some(
    (modifier) =>
      ts.isDecorator(modifier) &&
      ts.isCallExpression(modifier.expression) &&
      ts.isIdentifier(modifier.expression.expression) &&
      names.has(modifier.expression.expression.text),
  );
}

function parameterName(parameter) {
  return ts.isIdentifier(parameter?.name) ? parameter.name.text : undefined;
}

function isExported(node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isRequestHandler(node) {
  if (!ts.isFunctionLike(node) || !node.body) return false;
  if (ts.isMethodDeclaration(node)) return hasDecoratorNamed(node, ROUTE_DECORATORS);
  const [first, second] = node.parameters.map(parameterName);
  if (!first || !REQUEST_PARAMETER.test(first)) return false;
  if (second && RESPONSE_PARAMETER.test(second)) return true;
  return ts.isFunctionDeclaration(node) && isExported(node) && HTTP_VERB_EXPORTS.has(node.name?.text);
}

function enclosingRequestHandler(node) {
  return ts.findAncestor(node.parent, isRequestHandler);
}

function isResponseCall(call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !RESPONSE_METHODS.has(callee.name.text)) return false;
  let receiver = ts.skipOuterExpressions(callee.expression);
  while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
    receiver = ts.skipOuterExpressions(receiver.expression.expression);
  }
  return ts.isIdentifier(receiver) && RESPONSE_RECEIVER.test(receiver.text);
}

function identifiersNamed(root, name, declaration) {
  const found = [];
  (function visit(node) {
    if (ts.isIdentifier(node) && node.text === name && node !== declaration) found.push(node);
    ts.forEachChild(node, visit);
  })(root);
  return found;
}

function isTransparent(node) {
  return TRANSPARENT_KINDS.some((kind) => ts[kind](node));
}

// True when `value` is returned from `handler` or passed to a response call, possibly after being wrapped in an
// object or array, mapped, or stored in a local that is then returned. Stops at nested callbacks.
function reachesResponse(value, handler, depth = 0) {
  let current = value;
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
    if (ts.isReturnStatement(parent)) return ts.findAncestor(parent, ts.isFunctionLike) === handler;
    if (ts.isArrowFunction(parent) && parent.body === current) return parent === handler;
    if (ts.isFunctionLike(parent)) return false;
    if (isTransparent(parent)) continue;
    if (ts.isConditionalExpression(parent) && parent.condition !== current) continue;
    if (ts.isBinaryExpression(parent) && parent.left === current) continue;
    if (ts.isCallExpression(parent)) return parent.arguments.includes(current) && isResponseCall(parent);
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      const call = parent.parent;
      const isMethodCall = ts.isCallExpression(call) && call.expression === parent;
      if (isMethodCall && SIZE_PRESERVING_METHODS.has(parent.name.text)) {
        parent = call;
        continue;
      }
      if (isMethodCall || NARROWING_MEMBERS.has(parent.name.text)) return false;
      continue;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return ts.isIdentifier(parent.name) && depth < MAX_ALIAS_DEPTH && usesReachResponse(parent.name, handler, depth);
    }
    return false;
  }
  return false;
}

function usesReachResponse(declaredName, handler, depth) {
  return identifiersNamed(handler.body, declaredName.text, declaredName).some((use) =>
    reachesResponse(use, handler, depth + 1),
  );
}

module.exports = { enclosingRequestHandler, reachesResponse, isRequestHandler, parameterName };
