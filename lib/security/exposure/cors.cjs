'use strict';

// cors-credentials-any-origin: credentials are allowed for every origin.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { unwrap, objectLiteralOf, findProperty, isTrue, methodName } = require('./literals.cjs');

const ruleId = 'cors-credentials-any-origin';
const message =
  'CORS allows credentials from any origin, so any website a user visits can call this API with their cookies. List the allowed origins explicitly.';
const corsMiddlewareModules = new Set(['cors', '@koa/cors']);
const fastifyCorsModules = new Set(['@fastify/cors', 'fastify-cors']);
// `/.*/` and its anchored forms.
const matchEverythingPattern = /^\/\^?\.[*+]\$?\/[a-z]*$/;
const originHeaderPattern = /headers(?:\.origin|\[\s*['"]origin['"]\s*\])|\.(?:get|header)\(\s*['"]origin['"]\s*\)/i;
const headerSetters = new Set(['setHeader', 'header', 'set', 'append']);

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
  const origin = findProperty(options, 'origin');
  const credentials = findProperty(options, 'credentials');
  if (isTrue(credentials?.value) && allowsAnyOrigin(origin?.value)) context.report(origin.property, ruleId, message);
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
  const scope = ts.findAncestor(call, ts.isFunctionLike);
  if (scope && allowsCredentials(scope)) context.report(call, ruleId, message);
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
}

// `{ cors: { origin: '*', credentials: true } }` for NestFactory.create, Apollo, Yoga, socket.io and gateways.
function checkCorsProperty(property, context) {
  if (ts.isIdentifier(property.name) && property.name.text === 'cors') checkOptions(property.initializer, context);
}

module.exports = { checkCall, checkCorsProperty };
