import ts from 'typescript';
import { walkNodes } from './walk.cjs';
import type { SourceFile, Statement, WhileStatement } from 'typescript';
import type { Finding } from '../shared/types.cjs';

// Match a literal INSERT header followed by one bounded set of known wildcard forms.
// A quoted-string alternative or a delimiter-aware parser must never match this grammar.
function valuesCapture(literal: string): 1 | 2 | undefined {
  const end = literal.lastIndexOf('/');
  const flags = literal.slice(end + 1);
  if (!flags.includes('g')) return;
  const pattern = literal.slice(1, end);
  const tail = pattern.endsWith('([\\s\\S]*?);') ? '([\\s\\S]*?);' : '(.*?);';
  if (!pattern.endsWith(tail)) return;
  const header = pattern
    .slice(0, -tail.length)
    .replaceAll(/\\s[+*]|\s+/g, ' ')
    .trim();
  const tableAndColumns = /^\^?INSERT INTO (?:[A-Z_]\w*|"[A-Z_]\w*"|\x60[A-Z_]\w*\x60)(.*?) VALUES$/i.exec(header);
  if (!tableAndColumns) return;
  const columns = tableAndColumns[1].trim();
  if (!columns) return 1;
  if (columns === '\\(([^)]+)\\)') return 2;
}

interface LoopMatch {
  pattern: string;
  match: string;
}

function loopMatch(loop: WhileStatement): LoopMatch | undefined {
  if (!ts.isBlock(loop.statement)) return;
  const condition = ts.skipOuterExpressions(loop.expression);
  if (
    !ts.isBinaryExpression(condition) ||
    ![ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(
      condition.operatorToken.kind,
    ) ||
    condition.right.kind !== ts.SyntaxKind.NullKeyword
  )
    return;
  const assignment = ts.skipOuterExpressions(condition.left);
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(assignment.left) ||
    !ts.isCallExpression(assignment.right)
  )
    return;
  const method = assignment.right.expression;
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== 'exec' || !ts.isIdentifier(method.expression))
    return;
  return { pattern: method.expression.text, match: assignment.left.text };
}

// Require a direct use of the VALUES capture in the loop body. A test for an INSERT
// header, or code using only the captured column list, does not extract values this way.
function consumesCapture(body: Statement, match: string, index: number): boolean {
  if (!ts.isBlock(body)) return false;
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) break;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text === match) return false;
      const value = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
      if (
        value &&
        ts.isElementAccessExpression(value) &&
        ts.isIdentifier(value.expression) &&
        value.expression.text === match &&
        ts.isNumericLiteral(value.argumentExpression) &&
        Number(value.argumentExpression.text) === index
      )
        return true;
    }
  }
  return false;
}

function checkInsertTerminators(source: SourceFile, file: string): Finding[] {
  if (!/INSERT/i.test(source.text) || !source.text.includes('.exec')) return [];
  const findings: Finding[] = [];
  walkNodes(source, (loop) => {
    if (!ts.isWhileStatement(loop) || (!ts.isBlock(loop.parent) && !ts.isSourceFile(loop.parent))) return;
    const match = loopMatch(loop);
    if (!match) return;
    const siblings = loop.parent.statements;
    for (let index = siblings.indexOf(loop) - 1; index >= 0; index--) {
      const previous = siblings[index];
      if (!ts.isVariableStatement(previous)) continue;
      const declaration = previous.declarationList.declarations.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === match.pattern,
      );
      if (!declaration) continue;
      const regex = declaration.initializer;
      if (!(previous.declarationList.flags & ts.NodeFlags.Const) || !regex || !ts.isRegularExpressionLiteral(regex))
        return;
      const capture = valuesCapture(regex.text);
      if (!capture || !consumesCapture(loop.statement, match.match, capture)) return;
      const position = source.getLineAndCharacterOfPosition(regex.getStart(source));
      findings.push({
        file,
        line: position.line + 1,
        column: position.character + 1,
        ruleId: 'sql-insert-truncated-at-semicolon',
        message:
          "This SQL dump parser cuts INSERT values at the first semicolon, even inside a quoted field such as 'tea; coffee'. Read statements with a parser for the dump's SQL dialect, or track quoting and escapes before treating a semicolon as a terminator.",
      });
      return;
    }
  });
  return findings;
}

export { checkInsertTerminators };
