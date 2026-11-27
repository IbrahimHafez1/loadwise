import ts from 'typescript';
import type { ConciseBody, Expression, Statement } from 'typescript';

const comparisons = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanEqualsToken,
]);

function simpleRead(expression: Expression): boolean {
  const node = ts.skipOuterExpressions(expression);
  if (ts.isPropertyAccessExpression(node)) return simpleRead(node.expression);
  if (ts.isBinaryExpression(node)) {
    return comparisons.has(node.operatorToken.kind) && simpleRead(node.left) && simpleRead(node.right);
  }
  return (
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    (ts.isArrayLiteralExpression(node) && node.elements.length === 0)
  );
}

function optionalMessage(expression: Expression) {
  if (!ts.isSpreadElement(expression)) return;
  const choice = ts.skipOuterExpressions(expression.expression);
  if (!ts.isConditionalExpression(choice)) return;
  const whenTrue = ts.skipOuterExpressions(choice.whenTrue),
    whenFalse = ts.skipOuterExpressions(choice.whenFalse);
  if (!ts.isArrayLiteralExpression(whenTrue) || !ts.isArrayLiteralExpression(whenFalse)) return;
  const values = whenTrue.elements.length ? whenTrue.elements : whenFalse.elements;
  if (whenTrue.elements.length + whenFalse.elements.length === 1 && ts.isStringLiteralLike(values[0])) return choice;
}

function checklistContext(body: ConciseBody, score: number, threshold: number): string | undefined {
  if (!ts.isBlock(body) || body.statements.length !== 1) return;
  const statement = body.statements[0];
  const returns: Statement[] = [];
  if (ts.isSwitchStatement(statement) && ts.isIdentifier(statement.expression)) {
    for (const clause of statement.caseBlock.clauses) {
      if (
        ts.isCaseClause(clause) &&
        !ts.isStringLiteralLike(clause.expression) &&
        !ts.isNumericLiteral(clause.expression)
      )
        return;
      if (clause.statements.length !== 1) return;
      returns.push(clause.statements[0]);
    }
  } else returns.push(statement);
  let reads = 0;
  for (const result of returns) {
    if (!ts.isReturnStatement(result) || !result.expression || !ts.isArrayLiteralExpression(result.expression)) return;
    for (const element of result.expression.elements) {
      const choice = optionalMessage(element);
      if (!choice) return;
      if (simpleRead(choice.condition)) reads++;
    }
  }
  // Opaque predicates keep their full score. Never hide a function whose remaining decisions reach
  // the threshold.
  if (reads >= threshold - 1 && score - reads < threshold && reads * 2 > score) {
    return 'Most decisions select optional literal messages using simple field checks in a flat checklist.';
  }
}

export { checklistContext };
