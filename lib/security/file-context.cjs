'use strict';

const { syntax: ts } = require('../performance/compiler.cjs');
const { isTestSource: isPerformanceTestSource, isSeedSource } = require('../performance/review-context.cjs');

// Fixtures, mocks, examples and stories hold sample values on purpose, so security findings there are contextual.
const sampleSourcePattern = /(?:^|[/\\])(?:fixtures?|__fixtures__|mocks?|__mocks__|examples?|stories)[/\\]/i;
const storySourcePattern = /\.stories\.[cm]?[jt]sx?$/i;
const testSourceReason = 'Test or example source.';

function isTestSource(file) {
  return (
    isPerformanceTestSource(file) ||
    isSeedSource(file) ||
    sampleSourcePattern.test(file) ||
    storySourcePattern.test(file)
  );
}

const nonProductionNames = /^(?:isDev|isDevelopment|isTest|isLocal|debug|DEBUG)$/;

// `process.env.NODE_ENV !== 'production'`, `NODE_ENV === 'development'` or a dev flag such as `isDev`.
function isNonProductionCondition(condition) {
  const expression = ts.skipOuterExpressions(condition);
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const name = ts.isIdentifier(expression) ? expression.text : expression.name.text;
    return nonProductionNames.test(name);
  }
  if (!ts.isBinaryExpression(expression)) return false;
  const operator = expression.operatorToken.kind;
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
    return isNonProductionCondition(expression.left) || isNonProductionCondition(expression.right);
  const equality = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
  const inequality =
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
  if (!equality && !inequality) return false;
  const [environment, literal] = ts.isStringLiteralLike(expression.right)
    ? [expression.left, expression.right]
    : [expression.right, expression.left];
  if (!ts.isStringLiteralLike(literal) || !environment.getText().endsWith('NODE_ENV')) return false;
  return inequality ? literal.text === 'production' : literal.text !== 'production';
}

// True when `node` only runs on the branch of an if/conditional whose condition says the process is not production.
function underNonProductionGuard(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) {
      const [condition, thenBranch] = ts.isIfStatement(parent)
        ? [parent.expression, parent.thenStatement]
        : [parent.condition, parent.whenTrue];
      if (child === thenBranch && isNonProductionCondition(condition)) return true;
    }
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

function createFileContext(sourceFile) {
  const testSource = isTestSource(sourceFile.fileName);
  return {
    isTestSource: testSource,
    testSourceReason: testSource ? testSourceReason : undefined,
    underNonProductionGuard,
  };
}

module.exports = { createFileContext, isTestSource, underNonProductionGuard, testSourceReason };
