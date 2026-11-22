'use strict';

const { ts, textOf, indentationAt, calleeCall, enclosingStatement } = require('./helpers.cjs');
const { createPairMatcher } = require('../page-counts.cjs');

const pageCountPair = createPairMatcher(ts);

const MAX_ONE_LINE_LENGTH = 100;
const NEWLINE = '\n';

// The call's source with its method name swapped.
function withMethod(call, replacement) {
  const text = call.getSourceFile().text;
  const method = call.expression.name;
  return text.slice(call.getStart(), method.getStart()) + replacement + text.slice(method.end, call.end);
}

// TypeORM reads the page first and derives the total from it when it can, so the saving depends on the page.
function combinedCountNote(method) {
  return `${method}() reads the page first and skips the count query when the page is not full, so short or last pages cost one query. A full page (as many rows as take), an empty page past skip, or joins with limit() still run the count as a second query after the page, one after the other as before.`;
}

// Typed bindings would lose their annotation in a destructuring, so those stay manual.
function hasAnnotation(pair) {
  return [pair.statements[0], pair.statements.at(-1)].some(
    (statement) => statement.declarationList.declarations[0].type,
  );
}

// The combined `const [rows, count]` cannot carry `export` for one binding only, so exported pairs stay manual.
function hasModifiers(pair) {
  return [pair.statements[0], pair.statements.at(-1)].some((statement) => statement.modifiers?.length);
}

// Adjacent statements are separated only by trivia, so any comment there would be dropped by the replacement.
function commentBetween(pair) {
  const text = pair.statements[0].getSourceFile().text;
  return /\/[/*]/.test(text.slice(pair.statements[0].end, pair.statements.at(-1).getStart()));
}

function replacePair(pair, text) {
  return { edits: [{ start: pair.statements[0].getStart(), end: pair.statements.at(-1).end, text }] };
}

// Statements sit between the pair: the count statement disappears and the rows statement becomes the combined read.
function mergeIntoRows(pair, text) {
  const sourceFile = pair.rows.call.getSourceFile();
  const rowsStatement = pair.rows === pair.first ? pair.statements[0] : pair.statements.at(-1);
  const countStatement = pair.rows === pair.first ? pair.statements.at(-1) : pair.statements[0];
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

function promiseAllText(pair, indentation) {
  const [firstCall, secondCall] = [pair.first.call, pair.second.call].map(textOf);
  const names = `${pair.first.name}, ${pair.second.name}`;
  const oneLine = `const [${names}] = await Promise.all([${firstCall}, ${secondCall}]);`;
  if (!firstCall.includes('\n') && !secondCall.includes('\n') && oneLine.length <= MAX_ONE_LINE_LENGTH) return oneLine;
  return `const [${names}] = await Promise.all([\n${indentation}  ${firstCall},\n${indentation}  ${secondCall},\n${indentation}]);`;
}

function pageCountFix({ node, sourceFile }) {
  const statement = enclosingStatement(node);
  if (!statement || !ts.isVariableStatement(statement)) return;
  const pair = pageCountPair(statement);
  if (!pair || pair.first.call !== calleeCall(node) || hasAnnotation(pair) || hasModifiers(pair)) return;
  if (pair.statements.length === 2 && commentBetween(pair)) return;
  const { count, rows } = pair;
  const destructuring = `const [${rows.name}, ${count.name}] = await`;
  if (pair.kind === 'query-builder') {
    const text = `${destructuring} ${withMethod(rows.call, 'getManyAndCount')};`;
    const fix = pair.statements.length === 2 ? replacePair(pair, text) : mergeIntoRows(pair, text);
    return { ...fix, note: combinedCountNote('getManyAndCount') };
  }
  if (pair.kind === 'repository')
    return {
      ...replacePair(pair, `${destructuring} ${withMethod(rows.call, 'findAndCount')};`),
      note: combinedCountNote('findAndCount'),
    };
  return replacePair(pair, promiseAllText(pair, indentationAt(sourceFile.text, statement.getStart())));
}

module.exports = { 'count-then-page-serial': pageCountFix };
