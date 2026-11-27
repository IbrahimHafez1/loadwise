import { createPositionIndex } from './locations.js';
import type { CommonTableExpr, ParseResult, SelectStmt } from '@pgsql/types';
import type { ExplainCandidate, PgStatement, PgStatementNode } from '../types/pg-statements.js';
import type { SourcePosition } from '../types/source-position.js';
import type { StatementRange } from '../types/statement-range.js';
import * as loaded from 'libpg-query';

// The parts of libpg-query used here (typed locally so the optional package need not be installed).
interface LibpgQuery {
  loadModule(): Promise<void>;
  parseSync(query: string): ParseResult;
}

interface BlockTracker {
  word(word: string): void;
  insideBlock(): boolean;
}

interface ChunkParse {
  result?: ParseResult;
  failure?: unknown;
}

interface StatementParts {
  range: StatementRange;
  fileIndex: ReturnType<typeof createPositionIndex>;
  chunk: string;
  node: PgStatementNode | null;
  failure: unknown;
}

let queryModule: LibpgQuery | null = null;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (queryModule) return;
  // Lazy: the WASM module is only paid for when a Postgres migration is actually parsed.
  loading ??= (async () => {
    try {
      await loaded.loadModule();
      queryModule = loaded;
    } catch (error) {
      loading = null;
      throw error;
    }
  })();
  await loading;
}

function requireLoaded(): LibpgQuery {
  if (!queryModule) {
    throw new Error('pg-parser is not loaded: await ensureLoaded() before calling parse functions.');
  }
  return queryModule;
}

const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
const DOLLAR_TAG_MAX_LENGTH = 80;

function skipLineComment(text: string, index: number) {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

function skipBlockComment(text: string, index: number) {
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

function skipQuoted(text: string, index: number, quote: string, backslashEscapes: boolean): number {
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

function skipDollarQuoted(text: string, index: number) {
  const tag = DOLLAR_TAG.exec(text.slice(index, index + DOLLAR_TAG_MAX_LENGTH));
  if (!tag) return -1;
  const close = text.indexOf(tag[0], index + tag[0].length);
  return close === -1 ? text.length : close + tag[0].length;
}

function isWordOrDollarCharCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

function isEscapeStringStart(text: string, index: number) {
  const character = text[index];
  if ((character !== 'e' && character !== 'E') || text[index + 1] !== "'") return false;
  return index === 0 || !isWordOrDollarCharCode(text.charCodeAt(index - 1));
}

// Returns the index after the lexical unit starting at `index` when it hides semicolons, else -1.
function skipOpaqueUnit(text: string, index: number) {
  const character = text[index];
  if (character === '-' && text[index + 1] === '-') return skipLineComment(text, index);
  if (character === '/' && text[index + 1] === '*') return skipBlockComment(text, index);
  if (character === "'") return skipQuoted(text, index, "'", false);
  if (character === '"') return skipQuoted(text, index, '"', false);
  if (character === '$') return skipDollarQuoted(text, index);
  if (isEscapeStringStart(text, index)) return skipQuoted(text, index + 1, "'", true);
  return -1;
}

function skipTrivia(text: string, start: number, end: number) {
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
function createBlockTracker(): BlockTracker {
  const leadingWords: string[] = [];
  let depth = 0;
  const isRoutine = () => {
    const head = leadingWords.join(' ') + ' ';
    return ROUTINE_HEADS.some((routineHead) => head.startsWith(routineHead + ' '));
  };
  return {
    word(word: string) {
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
function splitStatements(text: string): StatementRange[] {
  const ranges: StatementRange[] = [];
  let chunkStart = 0;
  let index = 0;
  let blocks = createBlockTracker();
  const closeChunk = (chunkEnd: number) => {
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

function stripLeadingByteOrderMark(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const MAX_PARSE_CACHE = 512;
const MAX_CACHED_CHUNK_LENGTH = 16_384;
const parseCache = new Map<string, ChunkParse>();

function parseChunk(chunk: string): ChunkParse {
  const parser = requireLoaded();
  if (chunk.length > MAX_CACHED_CHUNK_LENGTH) {
    try {
      return { result: parser.parseSync(chunk) };
    } catch (error) {
      return { failure: error };
    }
  }
  const cached = parseCache.get(chunk);
  if (cached) {
    if (parseCache.size >= MAX_PARSE_CACHE) {
      parseCache.delete(chunk);
      parseCache.set(chunk, cached);
    }
    return cached;
  }
  let parsed: ChunkParse;
  try {
    parsed = { result: parser.parseSync(chunk) };
  } catch (error) {
    parsed = { failure: error };
  }
  parseCache.set(chunk, parsed);
  if (parseCache.size > MAX_PARSE_CACHE) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return parsed;
}

function readCursorPosition(failure: unknown): unknown {
  if (typeof failure !== 'object' || failure === null || !('sqlDetails' in failure)) return undefined;
  const details = failure.sqlDetails;
  if (typeof details !== 'object' || details === null || !('cursorPosition' in details)) return undefined;
  return details.cursorPosition;
}

function errorOffsetInChunk(failure: unknown, chunkLength: number): number {
  const cursor = readCursorPosition(failure);
  // libpg-query reports a 0-based character offset into the parsed text.
  return typeof cursor === 'number' && Number.isInteger(cursor) ? Math.max(0, Math.min(cursor, chunkLength)) : 0;
}

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function buildStatement({ range, fileIndex, chunk, node, failure }: StatementParts): PgStatement {
  let chunkIndex: ReturnType<typeof createPositionIndex> | undefined;
  const begin = fileIndex.fromCharOffset(range.start);
  const statement: PgStatement = {
    node,
    kind: node ? Object.keys(node)[0] : null,
    start: range.start,
    end: range.end,
    line: begin.line,
    column: begin.column,
    text: chunk,
    // Converts a node `location` (UTF-8 byte offset inside this statement) to a file position.
    locate: (nodeLocation: number): SourcePosition => {
      chunkIndex ??= createPositionIndex(chunk);
      return fileIndex.fromCharOffset(range.start + chunkIndex.byteToCharOffset(nodeLocation));
    },
  };
  if (failure) {
    const position = fileIndex.fromCharOffset(range.start + errorOffsetInChunk(failure, chunk.length));
    statement.error = { message: describeFailure(failure), line: position.line, column: position.column };
  }
  return statement;
}

function parseStatements(rawText: string): PgStatement[] {
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

function collectNodes(value: unknown, predicate: (key: string) => boolean, found: unknown[] = []): unknown[] {
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
// The values collectNodes returns sit under a node-kind key, so a non-null object there is that
// kind's body.
function isSelectStmt(value: unknown): value is SelectStmt {
  return typeof value === 'object' && value !== null;
}

function isCommonTableExpr(value: unknown): value is CommonTableExpr {
  return typeof value === 'object' && value !== null;
}

function describeSelectNode(select: SelectStmt): { hasInto: boolean; hasLockingClause: boolean } {
  const nestedSelects = collectNodes(select, (key) => key === 'SelectStmt').filter(isSelectStmt);
  const allSelects: SelectStmt[] = [select, ...nestedSelects];
  const lockingClauses = collectNodes(select, (key) => key === 'LockingClause');
  return {
    hasInto: allSelects.some((body) => Boolean(body?.intoClause)),
    hasLockingClause: lockingClauses.length > 0 || allSelects.some((body) => (body?.lockingClause ?? []).length > 0),
  };
}

function hasDataModifyingCte(node: PgStatementNode): boolean {
  const expressions = collectNodes(node, (key) => key === 'CommonTableExpr');
  return expressions.some((expression) => {
    const queryKind = Object.keys(isCommonTableExpr(expression) ? (expression.ctequery ?? {}) : {})[0];
    return queryKind !== undefined && queryKind !== 'SelectStmt';
  });
}

// Used to validate text a user wants to EXPLAIN: exactly one statement, and what kind of statement.
function parseExplainCandidate(sql: string): ExplainCandidate {
  const parsed = parseStatements(sql);
  if (parsed.length !== 1) {
    return { error: { message: `Expected one statement, found ${parsed.length}.`, line: 1, column: 1 } };
  }
  const [statement] = parsed;
  if (statement.error) return { error: statement.error };
  const select = statement.node?.SelectStmt;
  return {
    kind: statement.kind,
    ...(select ? describeSelectNode(select) : { hasInto: false, hasLockingClause: false }),
    hasDataModifyingCte: statement.node ? hasDataModifyingCte(statement.node) : false,
  };
}

export { ensureLoaded, parseStatements, parseExplainCandidate, splitStatements };
