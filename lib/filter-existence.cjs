'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { isStandardArrayCall, outerExpression, standardInterface } = require('./repeated.cjs');

const kinds = ts.SyntaxKind;
const logicalOperators = new Set([kinds.AmpersandAmpersandToken, kinds.BarBarToken]);
const predicateOperators = new Set([
  ...logicalOperators,
  kinds.QuestionQuestionToken,
  kinds.EqualsEqualsEqualsToken,
  kinds.ExclamationEqualsEqualsToken,
  kinds.LessThanToken,
  kinds.LessThanEqualsToken,
  kinds.GreaterThanToken,
  kinds.GreaterThanEqualsToken,
]);
const nativeIncludes = new Set(['Array', 'ReadonlyArray', 'String']);

function existenceComparison(length) {
  const expression = outerExpression(length);
  const parent = expression.parent;
  if (!ts.isBinaryExpression(parent)) return;
  const lengthOnLeft = parent.left === expression;
  const other = ts.skipOuterExpressions(lengthOnLeft ? parent.right : parent.left);
  if (!ts.isNumericLiteral(other) || Number(other.text) !== 0) return;
  switch (parent.operatorToken.kind) {
    case kinds.ExclamationEqualsEqualsToken:
    case kinds.ExclamationEqualsToken:
      return 'some()';
    case kinds.EqualsEqualsEqualsToken:
    case kinds.EqualsEqualsToken:
      return '!some()';
    case kinds.GreaterThanToken:
      return lengthOnLeft ? 'some()' : undefined;
    case kinds.LessThanToken:
      return lengthOnLeft ? undefined : 'some()';
    case kinds.LessThanEqualsToken:
      return lengthOnLeft ? '!some()' : undefined;
    case kinds.GreaterThanEqualsToken:
      return lengthOnLeft ? undefined : '!some()';
  }
}

function consumesTruthiness(length) {
  let expression = outerExpression(length);
  let parent = expression.parent;
  while (ts.isBinaryExpression(parent) && logicalOperators.has(parent.operatorToken.kind)) {
    expression = outerExpression(parent);
    parent = expression.parent;
  }
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
    return parent.expression === expression;
  if (ts.isConditionalExpression(parent) || ts.isForStatement(parent)) return parent.condition === expression;
  return ts.isPrefixUnaryExpression(parent) && parent.operator === kinds.ExclamationToken;
}

// Early exit changes how many times the predicate runs. Accept simple tests
// with recognized operations so callbacks with visible side effects stay intact.
function simpleTest(expression, checker) {
  const value = ts.skipOuterExpressions(expression);
  if (
    ts.isIdentifier(value) ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === kinds.TrueKeyword ||
    value.kind === kinds.FalseKeyword ||
    value.kind === kinds.NullKeyword
  )
    return true;
  if (ts.isPrefixUnaryExpression(value))
    return value.operator === kinds.ExclamationToken && simpleTest(value.operand, checker);
  if (ts.isBinaryExpression(value))
    return (
      predicateOperators.has(value.operatorToken.kind) &&
      simpleTest(value.left, checker) &&
      simpleTest(value.right, checker)
    );
  if (ts.isPropertyAccessExpression(value)) {
    const property = checker.getSymbolAtLocation(value.name);
    if (property?.declarations?.some(ts.isGetAccessorDeclaration)) return false;
    return simpleTest(value.expression, checker);
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'includes' &&
    value.arguments.length === 1
  ) {
    return (
      nativeIncludes.has(standardInterface(value, checker)) &&
      simpleTest(value.expression.expression, checker) &&
      simpleTest(value.arguments[0], checker)
    );
  }
  return false;
}

function checkFilterExistence(call, context, predicate) {
  if (!predicate || call.arguments.length !== 1) return;
  const length = outerExpression(call).parent;
  if (!ts.isPropertyAccessExpression(length) || length.name.text !== 'length' || ts.isOptionalChain(length)) return;
  const replacement = existenceComparison(length) || (consumesTruthiness(length) ? 'some()' : undefined);
  if (!replacement || !isStandardArrayCall(call, context.checker)) return;
  if (predicate.parameters.some((parameter) => parameter.initializer || !ts.isIdentifier(parameter.name))) return;
  let condition = predicate.body;
  if (ts.isBlock(condition)) {
    const [only] = condition.statements;
    if (condition.statements.length !== 1 || !ts.isReturnStatement(only) || !only.expression) return;
    condition = only.expression;
  }
  if (simpleTest(condition, context.checker)) {
    context.report(
      call.expression.name,
      'filter-for-existence',
      `filter() scans every element and allocates all matches only for an existence check. Use \`${replacement}\` with the same predicate; it stops at the first match, provided the predicate has no side effects.`,
    );
  }
}

module.exports = { checkFilterExistence };
