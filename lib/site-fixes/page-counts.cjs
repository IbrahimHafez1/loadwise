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

// Typed bindings would lose their annotation in a destructuring, so those stay manual.
function hasAnnotation(pair) {
  return [pair.statements[0], pair.statements.at(-1)].some(
    (statement) => statement.declarationList.declarations[0].type,
  );
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
  if (!pair || pair.first.call !== calleeCall(node) || hasAnnotation(pair)) return;
  const { count, rows } = pair;
  const destructuring = `const [${rows.name}, ${count.name}] = await`;
  if (pair.kind === 'query-builder') {
    const text = `${destructuring} ${withMethod(rows.call, 'getManyAndCount')};`;
    return pair.statements.length === 2 ? replacePair(pair, text) : mergeIntoRows(pair, text);
  }
  if (pair.kind === 'repository')
    return replacePair(pair, `${destructuring} ${withMethod(rows.call, 'findAndCount')};`);
  return replacePair(pair, promiseAllText(pair, indentationAt(sourceFile.text, statement.getStart())));
}

module.exports = { 'count-then-page-serial': pageCountFix };
