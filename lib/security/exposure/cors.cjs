'use strict';

// cors-credentials-any-origin: credentials are allowed for every origin.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const {
  unwrap,
  objectLiteralOf,
  findProperty,
  isTrue,
  methodName,
  enclosingBranches,
  underNonProductionGuard,
} = require('./literals.cjs');
const { checkOriginOption, checkTestCall } = require('./cors-origin-regex.cjs');

const ruleId = 'cors-credentials-any-origin';
const message =
  'CORS allows credentials from any origin, so any website a user visits can call this API with their cookies. List the allowed origins explicitly.';
const corsMiddlewareModules = new Set(['cors', '@koa/cors']);
const fastifyCorsModules = new Set(['@fastify/cors', 'fastify-cors']);
// `/.*/` and its anchored forms.
const matchEverythingPattern = /^\/\^?\.[*+]\$?\/[a-z]*$/;
const originHeaderPattern = /headers(?:\.origin|\[\s*['"]origin['"]\s*\])|\.(?:get|header)\(\s*['"]origin['"]\s*\)/i;
const headerSetters = new Set(['setHeader', 'header', 'set', 'append']);
// `allowed.includes(origin)`, `allowed.has(origin)`, `pattern.test(origin)`, `allowed.some((item) => item === origin)`.
const membershipMethods = new Set(['includes', 'has', 'test', 'some']);
// `allowed.indexOf(origin) > -1` and its equivalents.
const foundIndexTests = new Set(['> -1', '!== -1', '!= -1', '>= 0']);

// `(origin, callback) => callback(null, true)`, or one that echoes the origin back, with no condition in between.
function isAlwaysAllowCallback(origin) {
  if (!ts.isArrowFunction(origin) && !ts.isFunctionExpression(origin)) return false;
  const [originParameter, callbackParameter] = origin.parameters;
  if (!originParameter || !callbackParameter || !ts.isIdentifier(callbackParameter.name)) return false;
  let statement = origin.body;
  if (ts.isBlock(statement)) {
    if (statement.statements.length !== 1) return false;
    [statement] = statement.statements;
    if (ts.isReturnStatement(statement) || ts.isExpressionStatement(statement)) statement = statement.expression;
  }
  statement = unwrap(statement);
  if (!statement || !ts.isCallExpression(statement)) return false;
  const [error, allowed] = statement.arguments;
  const answersCallback =
    ts.isIdentifier(statement.expression) && statement.expression.text === callbackParameter.name.text;
  if (!answersCallback || error?.kind !== ts.SyntaxKind.NullKeyword || !allowed) return false;
  const answer = unwrap(allowed);
  return isTrue(answer) || (ts.isIdentifier(answer) && answer.text === originParameter.name.getText());
}

function allowsAnyOrigin(origin) {
  if (!origin) return false;
  if (ts.isStringLiteralLike(origin)) return origin.text === '*';
  if (isTrue(origin)) return true;
  if (ts.isRegularExpressionLiteral(origin)) return matchEverythingPattern.test(origin.text);
  return isAlwaysAllowCallback(origin);
}

function checkOptions(optionsExpression, context) {
  const options = objectLiteralOf(optionsExpression, context.checker);
  if (!options) return;
  checkOriginOption(options, context);
  const origin = findProperty(options, 'origin');
  const credentials = findProperty(options, 'credentials');
  if (!isTrue(credentials?.value) || !allowsAnyOrigin(origin?.value)) return;
  // Development servers commonly reflect any origin; production takes another branch.
  if (underNonProductionGuard(origin.property) || underNonProductionGuard(optionsExpression)) return;
  context.report(origin.property, ruleId, message);
}

function isCorsMiddleware(call, context) {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) && corsMiddlewareModules.has(importedFrom(callee, context.checker)?.module);
}

function isFastifyCorsRegistration(call, context) {
  const plugin = unwrap(call.arguments[0]);
  return (
    methodName(call) === 'register' &&
    plugin &&
    ts.isIdentifier(plugin) &&
    fastifyCorsModules.has(importedFrom(plugin, context.checker)?.module)
  );
}

// `res.setHeader('Access-Control-Allow-Origin', req.headers.origin)` with credentials allowed in the same function.
function checkManualHeaders(call, context) {
  if (!headerSetters.has(methodName(call)) || call.arguments.length < 2) return;
  const [name, value] = call.arguments;
  if (!ts.isStringLiteralLike(name) || name.text.toLowerCase() !== 'access-control-allow-origin') return;
  if (!originHeaderPattern.test(valueText(value, context))) return;
  if (underNonProductionGuard(call) || isAllowlistedOrigin(call, unwrap(value).getText())) return;
  const scope = ts.findAncestor(call, ts.isFunctionLike);
  if (scope && allowsCredentials(scope)) context.report(call, ruleId, message);
}

// The echoed origin sits in the true branch of a membership test on that same origin.
function isAllowlistedOrigin(call, originText) {
  for (const { condition, branch } of enclosingBranches(call))
    if (branch === 'true' && testsMembership(condition, originText)) return true;
  return false;
}

// A positive membership test in the condition, outside any negation.
function testsMembership(condition, originText) {
  const node = unwrap(condition);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
      return testsMembership(node.left, originText) || testsMembership(node.right, originText);
    if (operator === ts.SyntaxKind.BarBarToken)
      return testsMembership(node.left, originText) && testsMembership(node.right, originText);
    const left = unwrap(node.left);
    const comparison = `${node.operatorToken.getText()} ${node.right.getText()}`;
    return ts.isCallExpression(left) && methodName(left) === 'indexOf' && foundIndexTests.has(comparison)
      ? passesOrigin(left, originText)
      : false;
  }
  return ts.isCallExpression(node) && membershipMethods.has(methodName(node)) && passesOrigin(node, originText);
}

function passesOrigin(call, originText) {
  const [argument] = call.arguments;
  if (!argument) return false;
  const value = unwrap(argument);
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return value.getText() === originText;
  let mentioned = false;
  (function visit(node) {
    mentioned ||= ts.isIdentifier(node) && node.text === originText;
    if (!mentioned) ts.forEachChild(node, visit);
  })(value.body);
  return mentioned;
}

function valueText(expression, context) {
  const node = unwrap(expression);
  if (!ts.isIdentifier(node)) return node.getText();
  const declaration = context.checker.getSymbolAtLocation(node)?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
    ? declaration.initializer.getText()
    : node.getText();
}

function allowsCredentials(scope) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node) && headerSetters.has(methodName(node))) {
      const [name, value] = node.arguments;
      found =
        name !== undefined &&
        ts.isStringLiteralLike(name) &&
        name.text.toLowerCase() === 'access-control-allow-credentials' &&
        value !== undefined &&
        (isTrue(unwrap(value)) || (ts.isStringLiteralLike(value) && value.text === 'true'));
    }
    ts.forEachChild(node, visit);
  })(scope);
  return found;
}

function checkCall(call, context) {
  if (isCorsMiddleware(call, context) || methodName(call) === 'enableCors') checkOptions(call.arguments[0], context);
  else if (isFastifyCorsRegistration(call, context)) checkOptions(call.arguments[1], context);
  checkManualHeaders(call, context);
  checkTestCall(call, context);
}

// `{ cors: { origin: '*', credentials: true } }` for NestFactory.create, Apollo, Yoga, socket.io and gateways.
function checkCorsProperty(property, context) {
  if (ts.isIdentifier(property.name) && property.name.text === 'cors') checkOptions(property.initializer, context);
}

module.exports = { checkCall, checkCorsProperty };
