'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { executedQuery } = require('./drizzle.cjs');
const { drizzleTable, drizzleColumn } = require('./schema/drizzle-schema.cjs');
const { declaredInPackage, resolvedSymbol } = require('./schema/ts-helpers.cjs');
const { typeFromPackage } = require('./package-types.cjs');
const { createHash } = require('node:crypto');

function preflightDigest(read, write) {
  return createHash('sha256').update(read.getSourceFile().text.slice(read.pos, write.end)).digest('hex');
}

function existenceCheck(statement) {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  const { name, initializer } = statement.declarationList.declarations[0];
  if (
    !ts.isArrayBindingPattern(name) ||
    name.elements.length !== 1 ||
    !initializer ||
    !ts.isAwaitExpression(initializer)
  )
    return;
  const [binding] = name.elements;
  if (!ts.isBindingElement(binding) || !ts.isIdentifier(binding.name) || binding.initializer || binding.dotDotDotToken)
    return;
  if (ts.isCallExpression(initializer.expression)) return { binding: binding.name.text, call: initializer.expression };
}

function containsBinding(node, binding) {
  return (
    (ts.isIdentifier(node) && node.text === binding) ||
    ts.forEachChild(node, (child) => containsBinding(child, binding))
  );
}

function throwsOnExistence(guard, binding, operation) {
  if (!ts.isIfStatement(guard) || guard.elseStatement) return false;
  const branch =
    ts.isBlock(guard.thenStatement) && guard.thenStatement.statements.length === 1
      ? guard.thenStatement.statements[0]
      : guard.thenStatement;
  if (!ts.isThrowStatement(branch) || containsBinding(branch, binding)) return false;
  let condition = guard.expression;
  if (operation === 'delete') {
    if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false;
    condition = condition.operand;
  }
  return ts.isIdentifier(condition) && condition.text === binding;
}

// Accept equality on the declared table's columns and plain identifier values only.
function predicateFields(predicate, table, checker) {
  if (!predicate || !ts.isCallExpression(predicate)) return;
  const terms =
    resolvedSymbol(predicate.expression, checker)?.name === 'and' &&
    declaredInPackage(predicate.expression, checker, ['drizzle-orm'])
      ? predicate.arguments
      : [predicate];
  const fields = new Map();
  for (const term of terms) {
    if (
      !ts.isCallExpression(term) ||
      term.arguments.length !== 2 ||
      resolvedSymbol(term.expression, checker)?.name !== 'eq' ||
      !declaredInPackage(term.expression, checker, ['drizzle-orm'])
    )
      return;
    const [field, value] = term.arguments;
    const column = drizzleColumn(field, checker);
    if (column?.table !== table || !ts.isIdentifier(value) || fields.has(column.column)) return;
    fields.set(column.column, value.text);
  }
  return fields.size ? fields : undefined;
}

function insertedFields(object) {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  const fields = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    const value = property.initializer ?? property.name;
    if (!ts.isIdentifier(property.name) || !ts.isIdentifier(value) || fields.has(property.name.text)) return;
    fields.set(property.name.text, value.text);
  }
  return fields;
}

function sameDatabase(left, right) {
  if (ts.isIdentifier(left) && ts.isIdentifier(right)) return left.text === right.text;
  return (
    ts.isPropertyAccessExpression(left) &&
    ts.isPropertyAccessExpression(right) &&
    left.expression.kind === ts.SyntaxKind.ThisKeyword &&
    right.expression.kind === ts.SyntaxKind.ThisKeyword &&
    left.name.text === right.name.text
  );
}

function plainPredicate(call) {
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.questionDotToken) return false;
  return call.arguments.every(
    (argument) =>
      ts.isIdentifier(argument) ||
      (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression) && !argument.questionDotToken) ||
      (ts.isCallExpression(argument) && plainPredicate(argument)),
  );
}

function checkWritePreflight(call, context) {
  if (!ts.isAwaitExpression(call.parent) || !ts.isExpressionStatement(call.parent.parent)) return;
  const statement = call.parent.parent;
  const block = statement.parent;
  if (
    !ts.isBlock(block) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !['where', 'values'].includes(call.expression.name.text)
  )
    return;
  const position = block.statements.indexOf(statement);
  if (position < 2 || !ts.isIfStatement(block.statements[position - 1])) return;
  const check = existenceCheck(block.statements[position - 2]);
  if (!check) return;
  const checker = context.checker;
  const write = executedQuery(call, checker);
  const operation = write?.root.text;
  if (
    !['delete', 'insert'].includes(operation) ||
    write.steps.length !== 1 ||
    write.steps[0].name !== (operation === 'delete' ? 'where' : 'values') ||
    !throwsOnExistence(block.statements[position - 1], check.binding, operation)
  )
    return;
  const read = executedQuery(check.call, checker);
  if (
    read?.root.text !== 'select' ||
    read.root.parent.parent.arguments.length ||
    read.steps.map((step) => step.name).join('.') !== 'limit.where.from' ||
    read.steps[0].call.arguments[0]?.getText() !== '1' ||
    !sameDatabase(read.root.parent.expression, write.root.parent.expression)
  )
    return;
  const readTable = read.steps[2].call.arguments[0];
  const writeTable = write.root.parent.parent.arguments[0];
  if (!readTable || !writeTable) return;
  const table = drizzleTable(readTable, checker);
  if (!table || table !== drizzleTable(writeTable, checker)) return;
  const readFields = predicateFields(read.steps[1].call.arguments[0], table, checker);
  if (
    !readFields ||
    !table.indexes.some(
      (index) =>
        index.unique &&
        !index.predicate &&
        index.keys.length === readFields.size &&
        index.keys.every((key) => readFields.has(key.column)),
    )
  )
    return;
  const argument = write.steps[0].call.arguments[0];
  const writeFields = operation === 'insert' ? insertedFields(argument) : predicateFields(argument, table, checker);
  if (
    !writeFields ||
    writeFields.size !== readFields.size ||
    [...readFields].some(([field, value]) => writeFields.get(field) !== value) ||
    block.statements.slice(position + 1).some((later) => containsBinding(later, check.binding))
  )
    return;
  const advice =
    operation === 'insert'
      ? 'Another request can insert the same unique key after the check. Consider inserting directly and translating only a violation of the matching unique constraint.'
      : 'Another request can delete the row after the check. Consider testing the delete result for a missing row and preserving the existing error.';
  let details;
  if (
    operation === 'delete' &&
    ts.isIdentifier(readTable) &&
    ts.isIdentifier(writeTable) &&
    plainPredicate(read.steps[1].call.arguments[0]) &&
    plainPredicate(argument)
  ) {
    const receiver = write.root.parent.expression;
    const type = checker.getTypeAtLocation(receiver);
    const members = type.flags & ts.TypeFlags.Intersection ? type.types : [type];
    const getter =
      ts.isPropertyAccessExpression(receiver) &&
      resolvedSymbol(receiver.name, checker)?.declarations?.some(ts.isGetAccessorDeclaration);
    if (
      !getter &&
      members.some((member) => typeFromPackage(member, ['drizzle-orm/mysql2'], ['MySql2Database', 'MySql2Transaction']))
    )
      details = { mysql2DeletePreflight: preflightDigest(block.statements[position - 2], statement) };
  }
  context.report(
    read.root,
    'drizzle-write-preflight',
    `A separate existence check before the ${operation} adds a round trip. ${advice}`,
    undefined,
    details,
  );
}

module.exports = { checkWritePreflight, preflightDigest };
