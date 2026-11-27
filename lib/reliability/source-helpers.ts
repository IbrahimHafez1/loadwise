// Small syntax helpers shared by the reliability rules that read source files.
import { ts } from '../performance/compiler.js';
import { testSourcePattern } from '../maintainability/snapshot-context.js';
import { generatedSource } from '../maintainability/duplicates.js';
import type { ElementAccessExpression, Expression, Node, PropertyAccessExpression, SourceFile } from 'typescript';

type AccessExpression = PropertyAccessExpression | ElementAccessExpression;

// Static assets and bundled third-party code are copied as they are, not maintained here.
const vendoredFolder = /(?:^|\/)(?:vendors?|third[-_]party|assets)\//i;

// Test, vendored and generated sources are not the project's own code to fix.
function isIgnoredSource(sourceFile: SourceFile, file: string): boolean {
  return (
    testSourcePattern.test(file) || vendoredFolder.test(file.replaceAll('\\', '/')) || generatedSource(sourceFile, file)
  );
}

function withoutParentheses(expression: Expression): Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isAccess(node: Node): node is AccessExpression {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function isAssignmentOperator(kind: number): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isEqualityOperator(kind: number): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function isNegatedEquality(kind: number): boolean {
  return kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken;
}

export type { AccessExpression };
export { isAccess, isAssignmentOperator, isEqualityOperator, isIgnoredSource, isNegatedEquality, withoutParentheses };
