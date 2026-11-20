'use strict';

// Shared by site fixes that move an awaited call out of an expression into a statement placed before it.
const { ts, textOf, lineStart } = require('./helpers.cjs');

const neverFree = () => false;
const clockCalls = new Set(['Date.now', 'performance.now']);
const unaryWrites = new Set([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]);

// True when evaluating `node` has no effect another expression could observe, so its position among awaits is free.
function isPure(node, isFree = neverFree) {
  if (!node || isFree(node)) return true;
  if (ts.isIdentifier(node) || ts.isLiteralExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isFunctionLike(node) || ts.isRegularExpressionLiteral(node)) return true;
  if (
    [
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword,
      ts.SyntaxKind.SuperKeyword,
    ].includes(node.kind)
  )
    return true;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node))
    return isPure(node.expression, isFree);
  if (ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return isPure(node.expression, isFree);
  if (ts.isPropertyAccessExpression(node)) return isPure(node.expression, isFree);
  if (ts.isElementAccessExpression(node))
    return isPure(node.expression, isFree) && isPure(node.argumentExpression, isFree);
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => isPure(span.expression, isFree));
  if (ts.isPrefixUnaryExpression(node)) return !unaryWrites.has(node.operator) && isPure(node.operand, isFree);
  if (ts.isTypeOfExpression(node)) return isPure(node.expression, isFree);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return false;
    return isPure(node.left, isFree) && isPure(node.right, isFree);
  }
  if (ts.isConditionalExpression(node))
    return [node.condition, node.whenTrue, node.whenFalse].every((child) => isPure(child, isFree));
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((child) => isPure(child, isFree));
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return isPure(node.expression, isFree);
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((child) => isPure(child, isFree));
  if (ts.isPropertyAssignment(node)) return !ts.isComputedPropertyName(node.name) && isPure(node.initializer, isFree);
  if (ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) return true;
  if (ts.isCallExpression(node))
    return clockCalls.has(textOf(node.expression)) && node.arguments.every((child) => isPure(child, isFree));
  if (ts.isNewExpression(node)) {
    return textOf(node.expression) === 'Date' && (node.arguments ?? []).every((child) => isPure(child, isFree));
  }
  return false;
}

const sequentialBinaryOperators = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const transparentKinds = [
  ts.isParenthesizedExpression,
  ts.isAsExpression,
  ts.isNonNullExpression,
  ts.isSatisfiesExpression,
  ts.isTypeAssertionExpression,
  ts.isAwaitExpression,
  ts.isSpreadElement,
  ts.isSpreadAssignment,
  ts.isPropertyAssignment,
  ts.isVariableDeclaration,
  ts.isVariableStatement,
  ts.isReturnStatement,
  ts.isExpressionStatement,
  ts.isThrowStatement,
];

function isStatementList(node) {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node);
}

// Whether `parent` evaluates everything before `child` without effects, and always evaluates `child`.
function reachesChildPurely(parent, child, isFree) {
  if (transparentKinds.some((test) => test(parent))) return true;
  const before = (list) => list.slice(0, list.indexOf(child)).every((earlier) => isPure(earlier, isFree));
  if (ts.isVariableDeclarationList(parent))
    return parent.declarations
      .slice(0, parent.declarations.indexOf(child))
      .every((declaration) => isPure(declaration.initializer, isFree));
  if (ts.isObjectLiteralExpression(parent)) return before([...parent.properties]);
  if (ts.isArrayLiteralExpression(parent)) return before([...parent.elements]);
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    if (parent.expression === child) return true;
    if (parent.questionDotToken) return false;
    return isPure(parent.expression, isFree) && before([...(parent.arguments ?? [])]);
  }
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === child;
  if (ts.isElementAccessExpression(parent)) return parent.expression === child || isPure(parent.expression, isFree);
  if (ts.isBinaryExpression(parent)) {
    if (parent.left === child) return true;
    if (sequentialBinaryOperators.has(parent.operatorToken.kind)) return false;
    return isPure(parent.left, isFree);
  }
  if (ts.isConditionalExpression(parent)) return parent.condition === child;
  if (ts.isTemplateSpan(parent)) return true;
  if (ts.isTemplateExpression(parent))
    return parent.templateSpans
      .slice(0, parent.templateSpans.indexOf(child))
      .every((span) => isPure(span.expression, isFree));
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.expression === child;
  if (ts.isIfStatement(parent) || ts.isSwitchStatement(parent)) return parent.expression === child;
  return false;
}

// Where a hoisted line can go: before the statement that always runs `start`, or into a concise arrow body.
// Nodes accepted by `isFree` may be evaluated earlier than they are now (they are hoisted too).
function hoistAnchor(start, isFree) {
  let child = start;
  for (let parent = start.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isStatement(child) && isStatementList(parent)) return { statement: child };
    if (ts.isArrowFunction(parent) && parent.body === child) return { arrow: parent };
    if (ts.isFunctionLike(parent) || isStatementList(parent)) return;
    if (!reachesChildPurely(parent, child, isFree)) return;
  }
}

function startsOwnLine(statement) {
  const text = statement.getSourceFile().text;
  const start = statement.getStart();
  return /^[ \t]*$/.test(text.slice(lineStart(text, start), start));
}

module.exports = { isPure, hoistAnchor, startsOwnLine };
