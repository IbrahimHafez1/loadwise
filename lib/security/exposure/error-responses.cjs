'use strict';

// error-stack-in-response: the stack of an error, or a whole error object, goes back to the client.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { unwrap, chainRootName, underNonProductionGuard } = require('./literals.cjs');

const ruleId = 'error-stack-in-response';
const stackMessage =
  'This response includes the error stack, which reveals file paths, dependencies and code structure. Log the error server-side and return a generic message.';
const wholeErrorReason = 'A whole error object is returned; confirm it exposes no stack or internal details.';
const responseNames = new Set(['res', 'response', 'reply']);
const bodyWriters = new Set(['send', 'json', 'end']);
const webResponseNames = new Set(['Response', 'NextResponse']);
const expressErrorHandlerParameterCount = 4;
// `(err, req, res, next)`: one of the other parameters carries an Express name, unused ones often with a `_`.
const expressHandlerParameterName = /^_*(?:req|request|res|response|next)$/;

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

// `(err, req, res, next)`: the Express error-handler shape. Any four-parameter function is not one.
function isErrorHandlerParameter(declaration) {
  if (!ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const { parameters } = declaration.parent;
  return (
    parameters.length === expressErrorHandlerParameterCount &&
    parameters[0] === declaration &&
    parameters
      .slice(1)
      .some((parameter) => ts.isIdentifier(parameter.name) && expressHandlerParameterName.test(parameter.name.text))
  );
}

// The type is `Error` or extends it; a plain object with `message` and `stack` fields is not an error.
function isErrorDerived(type, checker, seen = new Set()) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) return type.types.some((member) => isErrorDerived(member, checker, seen));
  if (type.getSymbol()?.getName() === 'Error') return true;
  const target = type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference ? type.target : type;
  if (!target.isClassOrInterface()) return false;
  return checker.getBaseTypes(target).some((base) => isErrorDerived(base, checker, seen));
}

function isErrorTyped(identifier, checker) {
  return isErrorDerived(checker.getTypeAtLocation(identifier), checker);
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
    const narrowed = instanceofErrorTest(node.condition);
    // `err instanceof Error ? err.message : err`: the branch where `err` is known not to be an Error is not one.
    for (const [branch, notError] of [
      [node.whenTrue, narrowed?.negated],
      [node.whenFalse, narrowed && !narrowed.negated],
    ]) {
      const value = unwrap(branch);
      if (notError && ts.isIdentifier(value) && value.text === narrowed.name) continue;
      findWholeErrors(branch, checker, found);
    }
  }
  return found;
}

// `x instanceof Error` or `!(x instanceof Error)`: the tested name, and whether the test is negated.
function instanceofErrorTest(condition) {
  let node = unwrap(condition);
  let negated = false;
  while (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    negated = !negated;
    node = unwrap(node.operand);
  }
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return;
  const value = unwrap(node.left);
  if (!ts.isIdentifier(value) || unwrap(node.right).getText() !== 'Error') return;
  return { name: value.text, negated };
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
