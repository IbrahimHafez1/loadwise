// cors-credentials-any-origin: credentials are allowed for every origin.
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import {
  unwrap,
  objectLiteralOf,
  findProperty,
  isTrue,
  methodName,
  enclosingBranches,
  precedingExitGuards,
  underNonProductionGuard,
} from './literals.js';
import { checkOriginOption, checkTestCall } from './cors-origin-regex.js';
import type { CallExpression, Expression, Node, PropertyAssignment } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'cors-credentials-any-origin';
const message =
  'CORS allows credentials from any origin, so any website a user visits can call this API with their cookies. List the allowed origins explicitly.';
const corsMiddlewareModules = new Set(['cors', '@koa/cors']);
const fastifyCorsModules = new Set(['@fastify/cors', 'fastify-cors']);
// `/.*/` and its anchored forms.
const matchEverythingPattern = /^\/\^?\.[*+]\$?\/[a-z]*$/;
const originHeaderPattern = /headers(?:\.origin|\[\s*['"]origin['"]\s*\])|\.(?:get|header)\(\s*['"]origin['"]\s*\)/i;
const headerSetters = new Set(['setHeader', 'header', 'set', 'append']);
// `allowed.includes(origin)`, `allowed.has(origin)`, `pattern.test(origin)`, `allowed.some((item)
// => item === origin)`.
const membershipMethods = new Set(['includes', 'has', 'test', 'some']);
// `allowed.indexOf(origin) > -1` and its equivalents.
const foundIndexTests = new Set(['> -1', '!== -1', '!= -1', '>= 0']);
const missingIndexTests = new Set(['=== -1', '== -1', '< 0']);

// `(origin, callback) => callback(null, true)`, or one that echoes the origin back, with no
// condition in between.
function isAlwaysAllowCallback(origin: Expression) {
  if (!ts.isArrowFunction(origin) && !ts.isFunctionExpression(origin)) return false;
  const [originParameter, callbackParameter] = origin.parameters;
  if (!originParameter || !callbackParameter || !ts.isIdentifier(callbackParameter.name)) return false;
  let bodyExpression: Expression | undefined;
  if (ts.isBlock(origin.body)) {
    if (origin.body.statements.length !== 1) return false;
    const [onlyStatement] = origin.body.statements;
    if (ts.isReturnStatement(onlyStatement) || ts.isExpressionStatement(onlyStatement))
      bodyExpression = onlyStatement.expression;
  } else bodyExpression = origin.body;
  const statement = unwrap(bodyExpression);
  if (!statement || !ts.isCallExpression(statement)) return false;
  const [error, allowed] = statement.arguments;
  const answersCallback =
    ts.isIdentifier(statement.expression) && statement.expression.text === callbackParameter.name.text;
  if (!answersCallback || error?.kind !== ts.SyntaxKind.NullKeyword || !allowed) return false;
  const answer = unwrap(allowed);
  return isTrue(answer) || (ts.isIdentifier(answer) && answer.text === originParameter.name.getText());
}

function allowsAnyOrigin(origin: Expression | undefined) {
  if (!origin) return false;
  if (ts.isStringLiteralLike(origin)) return origin.text === '*';
  if (isTrue(origin)) return true;
  if (ts.isRegularExpressionLiteral(origin)) return matchEverythingPattern.test(origin.text);
  return isAlwaysAllowCallback(origin);
}

function checkOptions(optionsExpression: Expression, context: SecurityRuleContext) {
  const options = objectLiteralOf(optionsExpression, context.checker);
  if (!options) return;
  checkOriginOption(options, context);
  const origin = findProperty(options, 'origin');
  const credentials = findProperty(options, 'credentials');
  if (!origin || !isTrue(credentials?.value) || !allowsAnyOrigin(origin.value)) return;
  // Development servers commonly reflect any origin; production takes another branch.
  if (underNonProductionGuard(origin.property) || underNonProductionGuard(optionsExpression)) return;
  context.report(origin.property, ruleId, message);
}

function isCorsMiddleware(call: CallExpression, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee)) return false;
  const module = importedFrom(callee, context.checker)?.module;
  return module !== undefined && corsMiddlewareModules.has(module);
}

function isFastifyCorsRegistration(call: CallExpression, context: SecurityRuleContext) {
  const plugin = unwrap(call.arguments[0]);
  if (methodName(call) !== 'register' || !plugin || !ts.isIdentifier(plugin)) return false;
  const module = importedFrom(plugin, context.checker)?.module;
  return module !== undefined && fastifyCorsModules.has(module);
}

// `res.setHeader('Access-Control-Allow-Origin', req.headers.origin)` with credentials allowed in
// the same function.
function checkManualHeaders(call: CallExpression, context: SecurityRuleContext) {
  const setter = methodName(call);
  if (!setter || !headerSetters.has(setter) || call.arguments.length < 2) return;
  const [name, value] = call.arguments;
  if (!ts.isStringLiteralLike(name) || name.text.toLowerCase() !== 'access-control-allow-origin') return;
  if (!originHeaderPattern.test(valueText(value, context))) return;
  if (underNonProductionGuard(call) || isAllowlistedOrigin(call, unwrap(value).getText())) return;
  const scope = ts.findAncestor(call, ts.isFunctionLike);
  if (scope && allowsCredentials(scope)) context.report(call, ruleId, message);
}

// A negated membership test in an early-exit guard (`!allowed.includes(origin)`,
// `allowed.indexOf(origin) === -1`).
function rejectsNonMember(condition: Expression, originText: string): boolean {
  const node = unwrap(condition);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return testsMembership(node.operand, originText);
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.BarBarToken) {
      return rejectsNonMember(node.left, originText) || rejectsNonMember(node.right, originText);
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return rejectsNonMember(node.left, originText) && rejectsNonMember(node.right, originText);
    }
    const left = unwrap(node.left);
    const comparison = `${node.operatorToken.getText()} ${node.right.getText()}`;
    return ts.isCallExpression(left) && methodName(left) === 'indexOf' && missingIndexTests.has(comparison)
      ? passesOrigin(left, originText)
      : false;
  }
  return false;
}

// The echoed origin sits in the true branch of a membership test, or after an early-exit guard
// that rejects non-members.
function isAllowlistedOrigin(call: CallExpression, originText: string) {
  for (const { condition, branch } of enclosingBranches(call)) {
    if (branch === 'true' && testsMembership(condition, originText)) return true;
  }
  for (const condition of precedingExitGuards(call)) {
    if (rejectsNonMember(condition, originText)) return true;
  }
  return false;
}

// A positive membership test in the condition, outside any negation.
function testsMembership(condition: Expression, originText: string): boolean {
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
  if (!ts.isCallExpression(node)) return false;
  const method = methodName(node);
  return method !== undefined && membershipMethods.has(method) && passesOrigin(node, originText);
}

function passesOrigin(call: CallExpression, originText: string) {
  const [argument] = call.arguments;
  if (!argument) return false;
  const value = unwrap(argument);
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return value.getText() === originText;
  let mentioned = false;
  (function visit(node: Node): void {
    mentioned ||= ts.isIdentifier(node) && node.text === originText;
    if (!mentioned) ts.forEachChild(node, visit);
  })(value.body);
  return mentioned;
}

function valueText(expression: Expression, context: SecurityRuleContext) {
  const node = unwrap(expression);
  if (!ts.isIdentifier(node)) return node.getText();
  const declaration = context.checker.getSymbolAtLocation(node)?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
    ? declaration.initializer.getText()
    : node.getText();
}

function allowsCredentials(scope: Node) {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    const setter = ts.isCallExpression(node) ? methodName(node) : undefined;
    if (ts.isCallExpression(node) && setter !== undefined && headerSetters.has(setter)) {
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

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  if (isCorsMiddleware(call, context) || methodName(call) === 'enableCors') checkOptions(call.arguments[0], context);
  else if (isFastifyCorsRegistration(call, context)) checkOptions(call.arguments[1], context);
  checkManualHeaders(call, context);
  checkTestCall(call, context);
}

// `{ cors: { origin: '*', credentials: true } }` for NestFactory.create, Apollo, Yoga, socket.io
// and gateways.
function checkCorsProperty(property: PropertyAssignment, context: SecurityRuleContext) {
  if (ts.isIdentifier(property.name) && property.name.text === 'cors') checkOptions(property.initializer, context);
}

export { checkCall, checkCorsProperty };
