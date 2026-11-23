'use strict';

const { createPositionIndex } = require('./locations.cjs');

let queryModule = null;
let loading = null;

async function ensureLoaded() {
  if (queryModule) return;
  // Lazy: the WASM module is only paid for when a Postgres migration is actually parsed.
  loading ??= (async () => {
    const loaded = require('libpg-query');
    await loaded.loadModule();
    queryModule = loaded;
  })();
  await loading;
}

function requireLoaded() {
  if (!queryModule) {
    throw new Error('pg-parser is not loaded: await ensureLoaded() before calling parse functions.');
  }
  return queryModule;
}

const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
const DOLLAR_TAG_MAX_LENGTH = 80;

function skipLineComment(text, index) {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

function skipBlockComment(text, index) {
  // PostgreSQL block comments nest.
  let depth = 0;
  let cursor = index;
  while (cursor < text.length) {
    if (text.startsWith('/*', cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith('*/', cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return cursor;
    } else cursor += 1;
  }
  return text.length;
}

function skipQuoted(text, index, quote, backslashEscapes) {
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (backslashEscapes && character === '\\') cursor += 2;
    else if (character === quote) {
      if (text[cursor + 1] === quote) cursor += 2;
      else return cursor + 1;
    } else cursor += 1;
  }
  return text.length;
}

function skipDollarQuoted(text, index) {
  const tag = DOLLAR_TAG.exec(text.slice(index, index + DOLLAR_TAG_MAX_LENGTH));
  if (!tag) return -1;
  const close = text.indexOf(tag[0], index + tag[0].length);
  return close === -1 ? text.length : close + tag[0].length;
}

function isEscapeStringStart(text, index) {
  return /[eE]/.test(text[index]) && text[index + 1] === "'" && !/[\w$]/.test(text[index - 1] ?? '');
}

// Returns the index after the lexical unit starting at `index` when it hides semicolons, else -1.
function skipOpaqueUnit(text, index) {
  const character = text[index];
  if (character === '-' && text[index + 1] === '-') return skipLineComment(text, index);
  if (character === '/' && text[index + 1] === '*') return skipBlockComment(text, index);
  if (character === "'") return skipQuoted(text, index, "'", false);
  if (character === '"') return skipQuoted(text, index, '"', false);
  if (character === '$') return skipDollarQuoted(text, index);
  if (isEscapeStringStart(text, index)) return skipQuoted(text, index + 1, "'", true);
  return -1;
}

function skipTrivia(text, start, end) {
  let index = start;
  while (index < end) {
    if (/\s/.test(text[index])) index += 1;
    else if (text.startsWith('--', index)) index = skipLineComment(text, index);
    else if (text.startsWith('/*', index)) index = skipBlockComment(text, index);
    else break;
  }
  return Math.min(index, end);
}

const WORD = /[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y;
const ROUTINE_HEADS = [
  'create function',
  'create procedure',
  'create or replace function',
  'create or replace procedure',
];
const ROUTINE_HEAD_WORDS = 4;

// Like psql, a CREATE FUNCTION/PROCEDURE body written as `BEGIN ATOMIC ... END` keeps its inner semicolons;
// CASE ... END inside the body is counted so its END does not close the body early.
function createBlockTracker() {
  const leadingWords = [];
  let depth = 0;
  const isRoutine = () => {
    const head = leadingWords.join(' ') + ' ';
    return ROUTINE_HEADS.some((routineHead) => head.startsWith(routineHead + ' '));
  };
  return {
    word(word) {
      const lower = word.toLowerCase();
      if (leadingWords.length < ROUTINE_HEAD_WORDS) leadingWords.push(lower);
      if (lower === 'begin' && isRoutine()) depth += 1;
      else if (lower === 'case' && depth > 0) depth += 1;
      else if (lower === 'end' && depth > 0) depth -= 1;
    },
    insideBlock: () => depth > 0,
  };
}

// Splits on top-level semicolons. Drizzle's `--> statement-breakpoint` is an ordinary comment here.
function splitStatements(text) {
  const ranges = [];
  let chunkStart = 0;
  let index = 0;
  let blocks = createBlockTracker();
  const closeChunk = (chunkEnd) => {
    const start = skipTrivia(text, chunkStart, chunkEnd);
    if (start < chunkEnd) ranges.push({ start, end: chunkEnd });
  };
  while (index < text.length) {
    const skipped = skipOpaqueUnit(text, index);
    WORD.lastIndex = index;
    const word = skipped === -1 ? WORD.exec(text) : null;
    if (skipped !== -1) index = skipped;
    else if (word) {
      blocks.word(word[0]);
      index = WORD.lastIndex;
    } else if (text[index] === ';' && !blocks.insideBlock()) {
      closeChunk(index);
      index += 1;
      chunkStart = index;
      blocks = createBlockTracker();
    } else index += 1;
  }
  closeChunk(text.length);
  return ranges;
}

function stripLeadingByteOrderMark(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseChunk(chunk) {
  try {
    return { result: requireLoaded().parseSync(chunk) };
  } catch (error) {
    return { failure: error };
  }
}

function errorOffsetInChunk(failure, chunkLength) {
  const cursor = failure?.sqlDetails?.cursorPosition;
  // libpg-query reports a 0-based character offset into the parsed text.
  return Number.isInteger(cursor) ? Math.max(0, Math.min(cursor, chunkLength)) : 0;
}

function buildStatement({ range, fileIndex, chunk, node, failure }) {
  const chunkIndex = createPositionIndex(chunk);
  const begin = fileIndex.fromCharOffset(range.start);
  const statement = {
    node,
    kind: node ? Object.keys(node)[0] : null,
    start: range.start,
    end: range.end,
    line: begin.line,
    column: begin.column,
    text: chunk,
    // Converts a node `location` (UTF-8 byte offset inside this statement) to a file position.
    locate: (nodeLocation) => fileIndex.fromCharOffset(range.start + chunkIndex.byteToCharOffset(nodeLocation)),
  };
  if (failure) {
    const position = fileIndex.fromCharOffset(range.start + errorOffsetInChunk(failure, chunk.length));
    statement.error = { message: failure.message, line: position.line, column: position.column };
  }
  return statement;
}

function parseStatements(rawText) {
  requireLoaded();
  const text = stripLeadingByteOrderMark(rawText);
  const fileIndex = createPositionIndex(text);
  return splitStatements(text).map((range) => {
    const chunk = text.slice(range.start, range.end);
    const { result, failure } = parseChunk(chunk);
    const node = result?.stmts?.[0]?.stmt ?? null;
    return buildStatement({ range, fileIndex, chunk, node, failure });
  });
}

function collectNodes(value, predicate, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, predicate, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (predicate(key)) found.push(child);
      collectNodes(child, predicate, found);
    }
  }
  return found;
}

// Select bodies reachable without entering a subquery: the select itself plus UNION/INTERSECT arms.
function topLevelSelects(select) {
  if (!select) return [];
  return [select, ...topLevelSelects(select.larg), ...topLevelSelects(select.rarg)];
}

function describeSelectNode(select) {
  const allSelects = [select, ...collectNodes(select, (key) => key === 'SelectStmt')];
  const lockingClauses = collectNodes(select, (key) => key === 'LockingClause');
  return {
    hasInto: allSelects.some((body) => Boolean(body?.intoClause)),
    hasLockingClause: lockingClauses.length > 0 || allSelects.some((body) => (body?.lockingClause ?? []).length > 0),
  };
}

function hasDataModifyingCte(node) {
  const expressions = collectNodes(node, (key) => key === 'CommonTableExpr');
  return expressions.some((expression) => {
    const queryKind = Object.keys(expression.ctequery ?? {})[0];
    return queryKind !== undefined && queryKind !== 'SelectStmt';
  });
}

// Used to validate text a user wants to EXPLAIN: exactly one statement, and what kind of statement.
function parseExplainCandidate(sql) {
  const parsed = parseStatements(sql);
  if (parsed.length !== 1) {
    return { error: { message: `Expected one statement, found ${parsed.length}.`, line: 1, column: 1 } };
  }
  const [statement] = parsed;
  if (statement.error) return { error: statement.error };
  const select = statement.node.SelectStmt;
  return {
    kind: statement.kind,
    ...(select ? describeSelectNode(select) : { hasInto: false, hasLockingClause: false }),
    hasDataModifyingCte: hasDataModifyingCte(statement.node),
  };
}

module.exports = { ensureLoaded, parseStatements, parseExplainCandidate, splitStatements };
