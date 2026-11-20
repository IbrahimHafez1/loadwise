'use strict';

const { ts, textOf, replaceNode, insertLinesBefore, freshName } = require('./helpers.cjs');
const { literalAwaiting, directAwaits, skipParentheses } = require('../literal-awaits.cjs');

// Parents where `await Promise.all(...)` can replace an array literal without extra parentheses.
function needsNoParentheses(literal) {
  const parent = literal.parent;
  return (
    ts.isVariableDeclaration(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isExpressionStatement(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isParenthesizedExpression(parent) ||
    (ts.isCallExpression(parent) && parent.expression !== literal) ||
    (ts.isBinaryExpression(parent) && parent.right === literal)
  );
}

function awaitedOperands(awaits) {
  return awaits.map((awaited) => textOf(skipParentheses(awaited.expression)));
}

function arrayFix(literal) {
  const awaits = directAwaits(literal);
  if (awaits.length !== literal.elements.length) return;
  const all = `await Promise.all([${awaitedOperands(awaits).join(', ')}])`;
  return { edits: [replaceNode(literal, needsNoParentheses(literal) ? all : `(${all})`)] };
}

// Hoisting is only safe when the statement always runs the literal: a direct `const x = {...}` or `return {...}`.
function hoistableStatement(literal) {
  const parent = literal.parent;
  let statement;
  if (ts.isVariableDeclaration(parent) && parent.initializer === literal && ts.isIdentifier(parent.name)) {
    statement = parent.parent.parent;
    if (parent.parent.declarations.length !== 1 || !ts.isVariableStatement(statement)) return;
  } else if (ts.isReturnStatement(parent)) statement = parent;
  else return;
  return ts.isBlock(statement.parent) || ts.isSourceFile(statement.parent) ? statement : undefined;
}

function objectFix(literal, sourceFile) {
  const awaits = directAwaits(literal);
  const statement = hoistableStatement(literal);
  const { properties } = literal;
  if (!statement || awaits.length !== properties.length) return;
  if (!properties.every((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))) return;
  const names = properties.map((property) => freshName(sourceFile, property.name.text + 'Value'));
  if (names.includes(undefined)) return;
  const line = `const [${names.join(', ')}] = await Promise.all([${awaitedOperands(awaits).join(', ')}]);`;
  return {
    edits: [
      insertLinesBefore(statement, [line]),
      ...properties.map((property, index) => replaceNode(property.initializer, names[index])),
    ],
  };
}

function serialLiteralFix({ node, sourceFile }) {
  let call = node;
  while (call && !(ts.isCallExpression(call) && literalAwaiting(call))) call = call.parent;
  const found = call && literalAwaiting(call);
  if (!found) return;
  return ts.isArrayLiteralExpression(found.literal) ? arrayFix(found.literal) : objectFix(found.literal, sourceFile);
}

module.exports = { 'serial-awaits-in-literal': serialLiteralFix };
