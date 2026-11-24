import { ts, ownsLines, indentationAt, clauseCount, logicalOperand, readableCondition } from './helpers.cjs';
import type { Block, Expression, SignatureDeclaration, SourceFile, Statement } from 'typescript';
import type { CountedEdit } from '../types/site-fix-edits.cjs';

const comparisonOperators = new Set(['===', '!==', '==', '!=', '<', '<=', '>', '>=', 'in', 'instanceof']);

function booleanLiteral(expression: Expression): boolean | undefined {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
}

function asBoolean(written: Expression, positive: boolean, sourceFile: SourceFile): string {
  // `(a === b)` is already a boolean; converting the parenthesized form would give `!!(a === b)`.
  const condition = ts.skipParentheses(written);
  const text = condition.getText(sourceFile);
  if (positive && ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken)
    return text;
  if (
    positive &&
    ts.isBinaryExpression(condition) &&
    comparisonOperators.has(condition.operatorToken.getText(sourceFile))
  )
    return text;
  const tight =
    ts.isIdentifier(condition) ||
    ts.isPropertyAccessExpression(condition) ||
    ts.isElementAccessExpression(condition) ||
    ts.isCallExpression(condition) ||
    ts.isParenthesizedExpression(condition) ||
    (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken);
  return (positive ? '!!' : '!') + (tight ? text : '(' + text + ')');
}

function returnedValue(statement: Statement): Expression | undefined {
  if (ts.isBlock(statement) && statement.statements.length === 1) statement = statement.statements[0];
  if (ts.isReturnStatement(statement)) return statement.expression;
}

// Returning a boolean on the short-circuited path requires truth conversion even for 0, null, or an
// empty string.
function shortCircuitReturn(
  condition: Expression,
  matched: Expression,
  fallback: Expression,
  sourceFile: SourceFile,
): string | undefined {
  const whenMatched = booleanLiteral(matched);
  const otherwise = booleanLiteral(fallback);
  if (whenMatched === otherwise) return;
  if (whenMatched !== undefined && otherwise !== undefined) return asBoolean(condition, whenMatched, sourceFile);
  const useOr = whenMatched ?? otherwise;
  const value = whenMatched === undefined ? matched : fallback;
  const converted = asBoolean(condition, whenMatched === true || otherwise === false, sourceFile);
  let right = logicalOperand(value, sourceFile);
  if (useOr && ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    right = '(' + right + ')';
  return converted + (useOr ? ' || ' : ' && ') + right;
}

function booleanGuardReturns(block: Block, fn: SignatureDeclaration, sourceFile: SourceFile): CountedEdit[] {
  // Changing the number of returns can change TypeScript's inferred type predicates.
  if (/\.[cm]?tsx?$/i.test(sourceFile.fileName) && fn.type?.kind !== ts.SyntaxKind.BooleanKeyword) return [];
  const edits: CountedEdit[] = [];
  for (let index = 1; index < block.statements.length; index++) {
    const previous = block.statements[index - 1];
    const next = block.statements[index];
    if (!ts.isIfStatement(previous) || previous.elseStatement || !ts.isReturnStatement(next) || !next.expression)
      continue;
    const matched = returnedValue(previous.thenStatement);
    if (!matched || !ownsLines(previous) || !ownsLines(next)) continue;
    const start = previous.getStart(sourceFile);
    const original = sourceFile.text.slice(start, next.end);
    if (/\/\/|\/\*/.test(original)) continue;
    const value = shortCircuitReturn(previous.expression, matched, next.expression, sourceFile);
    if (!value || /[\r\n]/.test(value)) continue;
    const text = 'return ' + value + (original.endsWith(';') ? ';' : '');
    const clauses =
      clauseCount(previous.expression) +
      (booleanLiteral(matched) === undefined ? clauseCount(matched) : 0) +
      (booleanLiteral(next.expression) === undefined ? clauseCount(next.expression) : 0);
    if (readableCondition(indentationAt(sourceFile.text, start) + text, clauses))
      edits.push({ start, end: next.end, text, removed: 1 });
  }
  return edits;
}

export { booleanGuardReturns };
