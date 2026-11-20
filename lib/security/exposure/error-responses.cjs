'use strict';

// error-stack-in-response: the stack of an error, or a whole error object, goes back to the client.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { unwrap, chainRootName } = require('./literals.cjs');

const ruleId = 'error-stack-in-response';
const stackMessage =
  'This response includes the error stack, which reveals file paths, dependencies and code structure. Log the error server-side and return a generic message.';
const wholeErrorReason = 'A whole error object is returned; confirm it exposes no stack or internal details.';
const responseNames = new Set(['res', 'response', 'reply']);
const bodyWriters = new Set(['send', 'json', 'end']);
const webResponseNames = new Set(['Response', 'NextResponse']);
const expressErrorHandlerParameterCount = 4;

const nonProductionWhenTrue = [
  /NODE_ENV\s*(?:!==|!=)\s*['"]production['"]/,
  /NODE_ENV\s*(?:===|==)\s*['"](?:development|dev|local|test)['"]/,
  /(?<!!)\b(?:isDev|isDevelopment|isLocal|isTest)\b/,
  /!\s*(?:isProd|isProduction)\b/,
];
const nonProductionWhenFalse = [
  /NODE_ENV\s*(?:===|==)\s*['"]production['"]/,
  /(?<!!)\b(?:isProd|isProduction)\b/,
  /!\s*(?:isDev|isDevelopment|isLocal|isTest)\b/,
];

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

// True when `node` only runs outside production: inside the right branch of an environment check.
function underNonProductionGuard(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    let condition;
    let branch;
    if (ts.isIfStatement(parent)) {
      condition = parent.expression;
      branch = child === parent.thenStatement ? 'true' : child === parent.elseStatement ? 'false' : undefined;
    } else if (ts.isConditionalExpression(parent)) {
      condition = parent.condition;
      branch = child === parent.whenTrue ? 'true' : child === parent.whenFalse ? 'false' : undefined;
    } else if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      condition = parent.left;
      branch = child === parent.right ? 'true' : undefined;
    }
    if (!branch) continue;
    const text = condition.getText();
    if (matchesAny(branch === 'true' ? nonProductionWhenTrue : nonProductionWhenFalse, text)) return true;
  }
  return false;
}

function isNestException(expression, context) {
  const callee = unwrap(expression);
  return (
    ts.isIdentifier(callee) &&
    callee.text.endsWith('Exception') &&
    importedFrom(callee, context.checker)?.module === '@nestjs/common'
  );
}

function isCatchVariable(declaration) {
  return ts.isVariableDeclaration(declaration) && ts.isCatchClause(declaration.parent);
}

// `(err, req, res, next)`: the Express error-handler shape.
function isErrorHandlerParameter(declaration) {
  return (
    ts.isParameter(declaration) &&
    declaration.parent.parameters.length === expressErrorHandlerParameterCount &&
    declaration.parent.parameters[0] === declaration &&
    ts.isIdentifier(declaration.name)
  );
}

function isErrorTyped(identifier, checker) {
  const type = checker.getTypeAtLocation(identifier);
  return Boolean(type.getProperty('stack') && type.getProperty('message'));
}

function isWholeError(identifier, checker) {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration;
  if (!declaration) return false;
  return isCatchVariable(declaration) || isErrorHandlerParameter(declaration) || isErrorTyped(identifier, checker);
}

// The `.stack` reads anywhere inside the expression.
function findStackReads(expression, found = []) {
  const node = unwrap(expression);
  if (!node) return found;
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'stack') {
    found.push(node);
    return found;
  }
  if (ts.isFunctionLike(node)) return found;
  ts.forEachChild(node, (child) => {
    findStackReads(child, found);
  });
  return found;
}

// Error objects placed in the body as a whole: the value itself, an object property, a spread or an array item.
function findWholeErrors(expression, checker, found = []) {
  const node = unwrap(expression);
  if (!node) return found;
  if (ts.isIdentifier(node)) {
    if (isWholeError(node, checker)) found.push(node);
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isShorthandPropertyAssignment(property) && isWholeError(property.name, checker)) found.push(property);
      else if (ts.isPropertyAssignment(property)) findWholeErrors(property.initializer, checker, found);
      else if (ts.isSpreadAssignment(property)) findWholeErrors(property.expression, checker, found);
    }
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) findWholeErrors(element, checker, found);
  } else if (ts.isConditionalExpression(node)) {
    findWholeErrors(node.whenTrue, checker, found);
    findWholeErrors(node.whenFalse, checker, found);
  }
  return found;
}

function checkBody(body, context) {
  if (underNonProductionGuard(body)) return;
  for (const read of findStackReads(body))
    if (!underNonProductionGuard(read)) context.report(read, ruleId, stackMessage);
  for (const error of findWholeErrors(body, context.checker))
    if (!underNonProductionGuard(error)) context.report(error, ruleId, stackMessage, wholeErrorReason);
}

function checkCall(call, context) {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const name = callee.name.text;
  const receiver = unwrap(callee.expression);
  const writesBody =
    (bodyWriters.has(name) && responseNames.has(chainRootName(receiver))) ||
    (name === 'json' && ts.isIdentifier(receiver) && webResponseNames.has(receiver.text));
  if (!writesBody) return;
  for (const argument of call.arguments) checkBody(argument, context);
}

function checkNew(node, context) {
  const callee = unwrap(node.expression);
  const isResponse = ts.isIdentifier(callee) && callee.text === 'Response';
  if (!isResponse && !isNestException(node.expression, context)) return;
  if (node.arguments?.[0]) checkBody(node.arguments[0], context);
}

// `ctx.body = { stack: err.stack }`
function checkAssignment(node, context) {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const target = unwrap(node.left);
  const isBody =
    ts.isPropertyAccessExpression(target) && target.name.text === 'body' && chainRootName(target) === 'ctx';
  if (isBody) checkBody(node.right, context);
}

module.exports = { checkCall, checkNew, checkAssignment };
