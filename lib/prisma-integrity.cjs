'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { consumesPrismaQuery, isGeneratedPrismaFile, prismaModelName } = require('./prisma.cjs');
const { outsideWrappers } = require('./query-results.cjs');

const arithmetic = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
]);

function isPrismaTransactionMethod(name, checker) {
  if (name.text !== '$transaction') return false;
  const declarations = checker.getSymbolAtLocation(name)?.declarations;
  return Boolean(
    declarations?.length &&
    declarations.every(
      (declaration) =>
        declaration.parent.name?.text === 'PrismaClient' && isGeneratedPrismaFile(declaration.getSourceFile()),
    ),
  );
}

function sameReference(left, right, checker) {
  left = ts.skipOuterExpressions(left);
  right = ts.skipOuterExpressions(right);
  if (left.kind !== right.kind) return false;
  if (ts.isPropertyAccessExpression(left)) {
    return left.name.text === right.name.text && sameReference(left.expression, right.expression, checker);
  }
  if (left.kind === ts.SyntaxKind.ThisKeyword) {
    const bindsThis = (node) => (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node);
    return ts.findAncestor(left, bindsThis) === ts.findAncestor(right, bindsThis);
  }
  if (!ts.isIdentifier(left) || left.text !== right.text) return false;
  const binding = checker.getSymbolAtLocation(left);
  return Boolean(binding && binding === checker.getSymbolAtLocation(right));
}

function checkTransaction(call, context) {
  const callback = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !isPrismaTransactionMethod(call.expression.name, context.checker)
  )
    return;
  const client = call.expression.expression;
  function visit(node) {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression;
      const delegate = method.expression;
      if (ts.isPropertyAccessExpression(delegate) && sameReference(client, delegate.expression, context.checker)) {
        const result = outsideWrappers(node);
        // The transaction adopts the callback result even when the callback is synchronous.
        const returned = result === callback.body || ts.isReturnStatement(result.parent);
        if ((returned || consumesPrismaQuery(node, context.checker)) && prismaModelName(method.name, context.checker)) {
          context.report(
            method.name,
            'prisma-transaction-client-escape',
            'This operation uses the outer Prisma client inside its transaction callback. Use the callback client so the operation shares the transaction and rolls back with it.',
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
}

// Computed keys, duplicate names and spreads can override any apparent guard.
function objectField(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  let match;
  for (const property of object.properties) {
    if (
      (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
    )
      return;
    if (property.name.text !== name) continue;
    if (match) return;
    match = property;
  }
  return match;
}

function rowKey(options, checker) {
  const where = objectField(options, 'where')?.initializer;
  if (!where || !ts.isObjectLiteralExpression(where) || where.properties.length !== 1) return;
  const property = where.properties[0];
  if (!property.name || !ts.isIdentifier(property.name)) return;
  let value;
  if (ts.isShorthandPropertyAssignment(property)) value = checker.getShorthandAssignmentValueSymbol(property);
  if (ts.isPropertyAssignment(property)) {
    const expression = ts.skipOuterExpressions(property.initializer);
    if (ts.isIdentifier(expression)) value = checker.getSymbolAtLocation(expression);
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression))
      value = expression.kind + '/' + expression.text;
  }
  if (value !== undefined) return { name: property.name.text, value };
}

function writeStatement(call) {
  let expression = call;
  while (ts.isOuterExpression(expression.parent) || ts.isAwaitExpression(expression.parent))
    expression = expression.parent;
  const parent = expression.parent;
  if (ts.isReturnStatement(parent) || ts.isExpressionStatement(parent)) return parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    parent.parent.declarations?.length === 1 &&
    ts.isVariableStatement(parent.parent.parent)
  ) {
    return parent.parent.parent;
  }
}

function isNullGuard(statement, binding, checker) {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const condition = ts.skipOuterExpressions(statement.expression);
  if (
    !ts.isPrefixUnaryExpression(condition) ||
    condition.operator !== ts.SyntaxKind.ExclamationToken ||
    !sameReference(condition.operand, binding, checker)
  )
    return false;
  const branch = statement.thenStatement;
  const exit = ts.isBlock(branch) && branch.statements.length === 1 ? branch.statements[0] : branch;
  return ts.isReturnStatement(exit) || ts.isThrowStatement(exit);
}

function guardedBySerializable(update, checker) {
  const callback = ts.findAncestor(update, ts.isFunctionLike);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return false;
  let callbackExpression = callback;
  while (ts.isOuterExpression(callbackExpression.parent)) callbackExpression = callbackExpression.parent;
  const transaction = callbackExpression.parent;
  if (
    !ts.isCallExpression(transaction) ||
    transaction.arguments[0] !== callbackExpression ||
    !ts.isPropertyAccessExpression(transaction.expression) ||
    !callback.parameters[0] ||
    !sameReference(update.expression.expression.expression, callback.parameters[0].name, checker)
  )
    return false;
  const isolation = objectField(transaction.arguments[1], 'isolationLevel')?.initializer;
  if (!isolation) return false;
  const serializable = ts.isStringLiteral(isolation)
    ? isolation.text === 'Serializable'
    : ts.isPropertyAccessExpression(isolation) &&
      isolation.name.text === 'Serializable' &&
      ts.isPropertyAccessExpression(isolation.expression) &&
      isolation.expression.name.text === 'TransactionIsolationLevel';
  return serializable && isPrismaTransactionMethod(transaction.expression.name, checker);
}

function readThatSupplied(field, update, write, key, checker) {
  const value = ts.skipOuterExpressions(field.initializer);
  if (!ts.isBinaryExpression(value) || !arithmetic.has(value.operatorToken.kind)) return false;
  for (const operand of [value.left, value.right]) {
    const access = ts.skipOuterExpressions(operand);
    if (!ts.isPropertyAccessExpression(access) || access.name.text !== field.name.text) continue;
    const row = ts.skipOuterExpressions(access.expression);
    if (!ts.isIdentifier(row)) continue;
    const binding = checker.getSymbolAtLocation(row)?.valueDeclaration;
    if (
      !binding ||
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !(binding.parent.flags & ts.NodeFlags.Const) ||
      binding.parent.declarations.length !== 1
    )
      continue;
    const declaration = binding.parent.parent;
    if (!ts.isVariableStatement(declaration) || declaration.parent !== write.parent) continue;
    if (declaration.end !== write.pos) {
      const statements = write.parent.statements;
      if (!statements) continue;
      const readIndex = statements.indexOf(declaration);
      if (statements[readIndex + 2] !== write || !isNullGuard(statements[readIndex + 1], binding.name, checker))
        continue;
    }
    const initializer = ts.skipOuterExpressions(binding.initializer);
    if (!ts.isAwaitExpression(initializer)) continue;
    const read = ts.skipOuterExpressions(initializer.expression);
    if (
      !ts.isCallExpression(read) ||
      !ts.isPropertyAccessExpression(read.expression) ||
      !['findUnique', 'findUniqueOrThrow'].includes(read.expression.name.text) ||
      !sameReference(read.expression.expression, update.expression.expression, checker)
    )
      continue;
    const original = rowKey(read.arguments[0], checker);
    if (
      original?.name === key.name &&
      original.value === key.value &&
      prismaModelName(read.expression.name, checker) &&
      checker.getTypeAtLocation(access).flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)
    )
      return true;
  }
  return false;
}

function checkPrismaIntegrity(call, context) {
  const method = call.expression;
  if (!ts.isPropertyAccessExpression(method)) return;
  if (method.name.text === '$transaction') return checkTransaction(call, context);
  if (method.name.text !== 'update' || !ts.isPropertyAccessExpression(method.expression)) return;
  const options = call.arguments[0];
  const data = objectField(options, 'data')?.initializer;
  if (!data || !ts.isObjectLiteralExpression(data)) return;
  const calculated = data.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      ts.isBinaryExpression(ts.skipOuterExpressions(property.initializer)),
  );
  if (!calculated.length) return;
  const { checker } = context;
  const key = rowKey(options, checker);
  const write = writeStatement(call);
  if (
    !key ||
    !write ||
    !consumesPrismaQuery(call, checker) ||
    !prismaModelName(method.name, checker) ||
    guardedBySerializable(call, checker)
  )
    return;
  for (const field of calculated) {
    if (objectField(data, field.name.text) !== field) continue;
    if (readThatSupplied(field, call, write, key, checker)) {
      context.report(
        field.name,
        'prisma-read-modify-write',
        'This update calculates a new value from an earlier read of the same row. Concurrent writes can overwrite each other. Use an atomic numeric update, or check a version and handle conflicts with a retry.',
      );
    }
  }
}

module.exports = { checkPrismaIntegrity, isPrismaTransactionMethod, objectField };
