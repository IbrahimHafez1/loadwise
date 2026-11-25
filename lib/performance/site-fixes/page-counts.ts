import { ts, textOf, indentationAt, calleeCall, enclosingStatement } from './helpers.js';
import { createPairMatcher } from '../page-counts.js';
import type { CallExpression, Node, Statement } from 'typescript';
import type { PageCountPair } from '../types/page-count-pair.js';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

const pageCountPair = createPairMatcher(ts);

const MAX_ONE_LINE_LENGTH = 100;
const NEWLINE = '\n';

function firstStatement(pair: PageCountPair): Statement {
  return pair.statements[0];
}

function lastStatement(pair: PageCountPair): Statement {
  return pair.statements[pair.statements.length - 1];
}

// The call's source with its method name swapped.
function withMethod(call: CallExpression, method: Node, replacement: string): string {
  const text = call.getSourceFile().text;
  return text.slice(call.getStart(), method.getStart()) + replacement + text.slice(method.end, call.end);
}

// TypeORM reads the page first and derives the total from it when it can, so the saving depends on
// the page.
function combinedCountNote(method: string): string {
  return `${method}() reads the page first and skips the count query when the page is not full, so short or last pages cost one query. A full page (as many rows as take), an empty page past skip, or joins with limit() still run the count as a second query after the page, one after the other as before.`;
}

// Typed bindings would lose their annotation in a destructuring, so those stay manual.
function hasAnnotation(pair: PageCountPair): boolean {
  return [firstStatement(pair), lastStatement(pair)].some(
    (statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations[0].type,
  );
}

// The combined `const [rows, count]` cannot carry `export` for one binding only, so exported pairs
// stay manual.
function hasModifiers(pair: PageCountPair): boolean {
  return [firstStatement(pair), lastStatement(pair)].some(
    (statement) => ts.canHaveModifiers(statement) && statement.modifiers?.length,
  );
}

// Adjacent statements are separated only by trivia, so any comment there would be dropped by the
// replacement.
function commentBetween(pair: PageCountPair): boolean {
  const text = firstStatement(pair).getSourceFile().text;
  return /\/[/*]/.test(text.slice(firstStatement(pair).end, lastStatement(pair).getStart()));
}

function replacePair(pair: PageCountPair, text: string): { edits: TextEdit[] } {
  return { edits: [{ start: firstStatement(pair).getStart(), end: lastStatement(pair).end, text }] };
}

// Statements sit between the pair: the count statement disappears and the rows statement becomes
// the combined read.
function mergeIntoRows(pair: PageCountPair, text: string): { edits: TextEdit[] } {
  const sourceFile = pair.rows.call.getSourceFile();
  const rowsStatement = pair.rows === pair.first ? firstStatement(pair) : lastStatement(pair);
  const countStatement = pair.rows === pair.first ? lastStatement(pair) : firstStatement(pair);
  const lineStart = sourceFile.text.lastIndexOf(NEWLINE, countStatement.getStart() - 1) + 1;
  const lineEnd = sourceFile.text.indexOf(NEWLINE, countStatement.end);
  const alone =
    !sourceFile.text.slice(lineStart, countStatement.getStart()).trim() &&
    !sourceFile.text.slice(countStatement.end, lineEnd < 0 ? undefined : lineEnd).trim();
  const removal = alone
    ? { start: lineStart, end: lineEnd < 0 ? sourceFile.text.length : lineEnd + 1, text: '' }
    : { start: countStatement.getStart(), end: countStatement.end, text: '' };
  return { edits: [removal, { start: rowsStatement.getStart(), end: rowsStatement.end, text }] };
}

function promiseAllText(pair: PageCountPair, indentation: string): string {
  const [firstCall, secondCall] = [pair.first.call, pair.second.call].map(textOf);
  const names = `${pair.first.name}, ${pair.second.name}`;
  const oneLine = `const [${names}] = await Promise.all([${firstCall}, ${secondCall}]);`;
  if (!firstCall.includes('\n') && !secondCall.includes('\n') && oneLine.length <= MAX_ONE_LINE_LENGTH) return oneLine;
  return `const [${names}] = await Promise.all([\n${indentation}  ${firstCall},\n${indentation}  ${secondCall},\n${indentation}]);`;
}

function pageCountFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const statement = enclosingStatement(node);
  if (!statement || !ts.isVariableStatement(statement)) return;
  const pair: PageCountPair | undefined = pageCountPair(statement) || undefined;
  if (!pair || pair.first.call !== calleeCall(node) || hasAnnotation(pair) || hasModifiers(pair)) return;
  if (pair.statements.length === 2 && commentBetween(pair)) return;
  const { count, rows } = pair;
  const destructuring = `const [${rows.name}, ${count.name}] = await`;
  if (pair.kind === 'query-builder') {
    const text = `${destructuring} ${withMethod(rows.call, rows.method, 'getManyAndCount')};`;
    const fix = pair.statements.length === 2 ? replacePair(pair, text) : mergeIntoRows(pair, text);
    return { ...fix, note: combinedCountNote('getManyAndCount') };
  }
  if (pair.kind === 'repository')
    return {
      ...replacePair(pair, `${destructuring} ${withMethod(rows.call, rows.method, 'findAndCount')};`),
      note: combinedCountNote('findAndCount'),
    };
  return replacePair(pair, promiseAllText(pair, indentationAt(sourceFile.text, statement.getStart())));
}

export default { 'count-then-page-serial': pageCountFix };
