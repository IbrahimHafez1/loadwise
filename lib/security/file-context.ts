import path from 'node:path';
import { ts } from '../performance/compiler.js';
import {
  isTestSource as isPerformanceTestSource,
  isSeedSource,
  relativeToProject,
} from '../performance/review-context.js';
import type { Expression, Node, SourceFile } from 'typescript';

// Fixtures, mocks, examples and stories hold sample values on purpose, so security findings there
// are contextual.
const sampleSourcePattern = /(?:^|[/\\])(?:fixtures?|__fixtures__|mocks?|__mocks__|examples?|stories)[/\\]/i;
const storySourcePattern = /\.stories\.[cm]?[jt]sx?$/i;
// Shared test code named after its role: `jwt-test.helper.ts`, `test-utils.ts`, `testSetup.ts`.
const testHelperSourcePattern = /(?:^|[/\\._-])test[-_.]?(?:helpers?|utils?|setup|fixtures?)\.[cm]?[jt]sx?$/i;
const testSourceReason = 'Test or example source.';

// Relative to the folder Loadwise runs in, so a project that itself sits in an `examples/` folder
// keeps its findings while an example app inside the checked repository stays contextual. A file
// outside that folder is taken relative to its own project.
function relativeToCheckedFolder(file: string) {
  const relative = path.relative(process.cwd(), path.resolve(file));
  return relative.startsWith('..') || path.isAbsolute(relative) ? relativeToProject(file) : relative;
}

function isTestSource(file: string) {
  return (
    isPerformanceTestSource(file) ||
    isSeedSource(file) ||
    sampleSourcePattern.test(relativeToCheckedFolder(file)) ||
    storySourcePattern.test(file) ||
    testHelperSourcePattern.test(file)
  );
}

const nonProductionNames = /^(?:isDev|isDevelopment|isTest|isLocal|debug|DEBUG)$/;

// `process.env.NODE_ENV !== 'production'`, `NODE_ENV === 'development'` or a dev flag such as
// `isDev`.
function isNonProductionCondition(condition: Expression): boolean {
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

// True when `node` only runs on the branch of an if/conditional whose condition says the process is
// not production.
function underNonProductionGuard(node: Node) {
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

function createFileContext(sourceFile: SourceFile) {
  const testSource = isTestSource(sourceFile.fileName);
  return {
    isTestSource: testSource,
    testSourceReason: testSource ? testSourceReason : undefined,
    underNonProductionGuard,
  };
}

export { createFileContext, isTestSource, underNonProductionGuard, testSourceReason };
