import { loadSyntax } from './compiler.cjs';
import type { Expression, ReturnStatement, Statement } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

const returnKeyword = 'return';

function looksLikeValue(node: Expression): boolean {
  const value = ts.skipOuterExpressions(node);
  if (ts.isIdentifier(value)) return value.text !== 'undefined';
  return (
    ts.isLiteralExpression(value) ||
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    ts.isPropertyAccessExpression(value) ||
    ts.isElementAccessExpression(value) ||
    ts.isTemplateExpression(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.JsxElement ||
    value.kind === ts.SyntaxKind.JsxSelfClosingElement ||
    value.kind === ts.SyntaxKind.JsxFragment
  );
}

function looksLikeReturnValue(statement: Statement): boolean {
  if (ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression)) {
    return looksLikeValue(statement.expression);
  }
  // `{ key: value }` can parse as a block with a label. A semicolon after the
  // value or any additional statements make it look like an intentional block.
  if (!ts.isBlock(statement) || statement.statements.length !== 1) return false;
  const [label] = statement.statements;
  return (
    ts.isLabeledStatement(label) &&
    ts.isExpressionStatement(label.statement) &&
    label.statement.getEnd() === label.statement.expression.getEnd() &&
    looksLikeValue(label.statement.expression)
  );
}

function checkReturnNewline(statement: ReturnStatement, { report }: PerformanceRuleContext) {
  if (statement.expression || !ts.isBlock(statement.parent)) return;
  const source = statement.getSourceFile();
  const start = statement.getStart(source);
  const end = statement.getEnd();
  if (end !== start + returnKeyword.length) return;

  const siblings = statement.parent.statements;
  const index = siblings.indexOf(statement);
  const next = index < 0 ? undefined : siblings[index + 1];
  if (!next || !looksLikeReturnValue(next)) return;
  const nextStart = next.getStart(source);
  const returnLine = source.getLineAndCharacterOfPosition(start).line;
  const nextLine = source.getLineAndCharacterOfPosition(nextStart).line;
  if (nextLine !== returnLine + 1 || source.text.slice(end, nextStart).trim() !== '') return;

  report(
    statement,
    'return-newline',
    'The newline after `return` inserts a semicolon, so this return supplies `undefined`. Start the intended value on the same line as `return`.',
  );
}

export { checkReturnNewline };
