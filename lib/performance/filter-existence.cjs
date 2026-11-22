'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
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

// Comparisons written as `length OPERATOR threshold`; a literal on the left uses the mirrored operator.
const mirroredOperators = new Map([
  [kinds.LessThanToken, kinds.GreaterThanToken],
  [kinds.GreaterThanToken, kinds.LessThanToken],
  [kinds.LessThanEqualsToken, kinds.GreaterThanEqualsToken],
  [kinds.GreaterThanEqualsToken, kinds.LessThanEqualsToken],
]);
const existenceTests = new Map([
  [
    0,
    new Map([
      [kinds.ExclamationEqualsEqualsToken, 'some()'],
      [kinds.ExclamationEqualsToken, 'some()'],
      [kinds.EqualsEqualsEqualsToken, '!some()'],
      [kinds.EqualsEqualsToken, '!some()'],
      [kinds.GreaterThanToken, 'some()'],
      [kinds.LessThanEqualsToken, '!some()'],
    ]),
  ],
  [
    1,
    new Map([
      [kinds.GreaterThanEqualsToken, 'some()'],
      [kinds.LessThanToken, '!some()'],
    ]),
  ],
]);

function existenceComparison(length) {
  const expression = outerExpression(length);
  const parent = expression.parent;
  if (!ts.isBinaryExpression(parent)) return;
  const lengthOnLeft = parent.left === expression;
  const other = ts.skipOuterExpressions(lengthOnLeft ? parent.right : parent.left);
  if (!ts.isNumericLiteral(other)) return;
  const operator = parent.operatorToken.kind;
  const normalized = lengthOnLeft ? operator : (mirroredOperators.get(operator) ?? operator);
  return existenceTests.get(Number(other.text))?.get(normalized);
}

function isBooleanConversion(call, checker) {
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return false;
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isIdentifier(callee) || callee.text !== 'Boolean') return false;
  const declarations = checker.getSymbolAtLocation(callee)?.declarations;
  return (
    !!declarations?.length &&
    declarations.every((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
  );
}

function consumesTruthiness(length, checker) {
  let expression = outerExpression(length);
  let parent = expression.parent;
  while (ts.isBinaryExpression(parent) && logicalOperators.has(parent.operatorToken.kind)) {
    expression = outerExpression(parent);
    parent = expression.parent;
  }
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
    return parent.expression === expression;
  if (ts.isConditionalExpression(parent) || ts.isForStatement(parent)) return parent.condition === expression;
  if (isBooleanConversion(parent, checker)) return true;
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
  const replacement =
    existenceComparison(length) || (consumesTruthiness(length, context.checker) ? 'some()' : undefined);
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
