'use strict';

const ts = require('typescript');
const order = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]);

// Restrict equivalence to simple storage locations. A computed key or call may change between reads.
function slot(node) {
  node = ts.skipOuterExpressions(node);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isElementAccessExpression(node) && !node.questionDotToken &&
      ts.isIdentifier(node.expression) && ts.isIdentifier(node.argumentExpression)) {
    return node.expression.text + '[' + node.argumentExpression.text + ']';
  }
}

function assignment(statement) {
  if (!ts.isExpressionStatement(statement)) return;
  const expression = statement.expression;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) return expression;
}

function retainsExtreme(condition, statements) {
  if (!ts.isBinaryExpression(condition) || !order.has(condition.operatorToken.kind) ||
      statements.length !== 1) return false;
  const left = slot(condition.left), right = slot(condition.right);
  if (!left || !right || left === right) return false;
  const write = assignment(statements[0]);
  if (!write) return false;
  const destination = slot(write.left), value = slot(write.right);
  return (destination === left && value === right) || (destination === right && value === left);
}

function testsUnseen(condition, mark) {
  const node = ts.skipOuterExpressions(condition);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return testsUnseen(node.left, mark) || testsUnseen(node.right, mark);
  }
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && slot(node.operand) === mark;
}

function addsUnseen(condition, statements) {
  if (statements.length !== 2) return false;
  const mark = assignment(statements[0]);
  if (!mark || !ts.isElementAccessExpression(mark.left) || !(mark.right.kind === ts.SyntaxKind.TrueKeyword ||
      (ts.isNumericLiteral(mark.right) && mark.right.text === '1'))) return false;
  const location = slot(mark.left);
  if (!location || !testsUnseen(condition, location) || !ts.isExpressionStatement(statements[1])) return false;
  const item = mark.left.argumentExpression.text;
  const append = statements[1].expression;
  return ts.isCallExpression(append) && ts.isPropertyAccessExpression(append.expression) &&
    ts.isIdentifier(append.expression.expression) && append.expression.name.text === 'push' &&
    append.arguments.length === 1 && ts.isIdentifier(append.arguments[0]) && append.arguments[0].text === item;
}

function traversalLeaf(node, enclosingLoops) {
  if (enclosingLoops < 2 || !ts.isIfStatement(node) || node.elseStatement) return false;
  const statements = ts.isBlock(node.thenStatement) ? node.thenStatement.statements : [node.thenStatement];
  return retainsExtreme(ts.skipOuterExpressions(node.expression), statements) || addsUnseen(node.expression, statements);
}

module.exports = { traversalLeaf };
