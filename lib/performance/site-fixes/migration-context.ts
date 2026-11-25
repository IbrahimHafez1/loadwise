// SQL scanning, literal decoding/encoding, migration context resolution and statement anatomy
// helpers shared across migration site-fix rules.
import path from 'node:path';
import { detectFramework } from '../migrations/extract-code.js';
import { ts, ancestor } from './helpers.js';
import type { Node } from 'typescript';
import type { SiteFixInput } from '../../shared/types.js';
import type {
  AlterParts,
  IndexedMatch,
  MigrationContext,
  QueryLiteral,
  ScanOptions,
  SqlStatement,
  StatementRange,
  SubcommandRange,
} from '../types/migrations.js';

export const IDENT = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\$\{[^}]*\}|[A-Za-z_][\w$]*)`;
export const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;
const ALTER_HEADER = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s*`, 'id');
const DOLLAR_QUOTE = /\$([A-Za-z_]\w*)?\$/y;
const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

// --- Scanning SQL text (raw file text, or the raw content of a JS string literal)
// -------------------------------

// Index just past the quoted string, comment or template hole that starts at `index`, or `index`
// when none does.
function skipOpaque(text: string, index: number, end: number, { escapes, holes }: ScanOptions): number {
  const char = text[index];
  const next = text[index + 1];
  if (escapes && char === '\\') return Math.min(index + 2, end);
  if (holes && char === '$' && next === '{') return closeBrace(text, index + 2, end);
  if (char === '-' && next === '-') {
    const newline = text.indexOf('\n', index);
    return newline === -1 || newline > end ? end : newline;
  }
  if (char === '/' && next === '*') {
    const close = text.indexOf('*/', index + 2);
    return close === -1 || close + 2 > end ? end : close + 2;
  }
  if (char === "'" || char === '"' || (char === '`' && !holes)) return closingQuote(text, index, end, char, escapes);
  if (char === '$' && !/[\w$]/.test(text[index - 1] ?? '')) {
    DOLLAR_QUOTE.lastIndex = index;
    const match = DOLLAR_QUOTE.exec(text);
    if (match) {
      const close = text.indexOf(match[0], index + match[0].length);
      return close === -1 ? end : Math.min(close + match[0].length, end);
    }
  }
  return index;
}

function closingQuote(text: string, index: number, end: number, quote: string, escapes: boolean): number {
  for (let position = index + 1; position < end; position++) {
    if (escapes && text[position] === '\\') position++;
    else if (text[position] === quote) {
      if (text[position + 1] !== quote) return position + 1;
      position++;
    }
  }
  return end;
}

function closeBrace(text: string, index: number, end: number): number {
  let depth = 1;
  for (let position = index; position < end; position++) {
    if (text[position] === '{') depth++;
    else if (text[position] === '}' && --depth === 0) return position + 1;
  }
  return end;
}

// Calls `visit(index, char, depth)` for every character outside strings, comments and template
// holes.
function scanCode(
  text: string,
  start: number,
  end: number,
  options: ScanOptions,
  visit: (index: number, char: string, depth: number) => void,
): void {
  let depth = 0;
  for (let index = start; index < end;) {
    const skipped = skipOpaque(text, index, end, options);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = text[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else visit(index, char, depth);
    index++;
  }
}

// The same text with string, identifier and comment contents blanked, so keyword regexes only see
// SQL code.
export function mask(sql: string, holes: boolean): string {
  let masked = '';
  let index = 0;
  const options = { escapes: false, holes };
  while (index < sql.length) {
    const skipped = skipOpaque(sql, index, sql.length, options);
    if (skipped === index) {
      masked += sql[index++];
      continue;
    }
    const span = sql.slice(index, skipped);
    const keepsDelimiters = /^["'`]|^\$\{/.test(span) && span.length >= 2;
    masked += keepsDelimiters ? span[0] + ' '.repeat(span.length - 2) + span.at(-1) : ' '.repeat(span.length);
    index = skipped;
  }
  return masked;
}

// The masked SQL with everything inside parentheses filled with `#` (spaces would let `\s+` cross
// it), so a keyword match skips `CHECK (c IS NOT NULL)`.
export function outsideParentheses(masked: string): string {
  let depth = 0;
  let result = '';
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index];
    if (char === '(') depth++;
    result += depth > 0 ? '#' : char;
    if (char === ')') depth--;
  }
  return result;
}

function skipLeadingTrivia(text: string, start: number, end: number, options: ScanOptions): number {
  let index = start;
  for (;;) {
    while (index < end && /\s/.test(text[index])) index++;
    const isComment = text.startsWith('--', index) || text.startsWith('/*', index);
    if (!isComment) return index;
    index = skipOpaque(text, index, end, options);
  }
}

function splitStatements(text: string, start: number, end: number, options: ScanOptions): StatementRange[] {
  const statements: StatementRange[] = [];
  let from = start;
  const push = (to: number, semicolon: number | null): void => {
    const first = skipLeadingTrivia(text, from, to, options);
    let last = to;
    while (last > first && /\s/.test(text[last - 1])) last--;
    if (last > first) statements.push({ start: first, end: last, semicolon });
  };
  scanCode(text, start, end, options, (index: number, char) => {
    if (char !== ';') return;
    push(index, index);
    from = index + 1;
  });
  push(end, null);
  return statements;
}

// --- Literal encoding
// --------------------------------------------------------------------------------------------

function decodeRaw(raw: string, quote: string | null): string {
  if (!quote) return raw;
  return raw.replaceAll(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g,
    (match: string, escape: string) => {
      if (escape.startsWith('u') && escape.length > 1)
        return String.fromCodePoint(parseInt(escape.replaceAll(/[u{}]/g, ''), 16));
      if (escape.startsWith('x') && escape.length === 3) return String.fromCharCode(parseInt(escape.slice(1), 16));
      if (escape.includes('\n')) return '';
      return SIMPLE_ESCAPES[escape] ?? escape;
    },
  );
}

export function encode(sql: string, quote: string | null): string {
  if (!quote) return sql;
  const escaped = sql.replaceAll('\\', '\\\\');
  if (quote === '`') return escaped.replaceAll('`', '\\`');
  return escaped.replaceAll(quote, '\\' + quote).replaceAll(/\r?\n/g, '\\n');
}

// Decoding turns an escaped `\${` into the same text as a live hole, so re-encoding the SQL would
// make it live. More `${` after decoding than the template has holes means one of them was escaped.
function hasEscapedHole({
  literal,
  text,
  regionStart,
  regionEnd,
}: Pick<MigrationContext, 'literal' | 'text' | 'regionStart' | 'regionEnd'>): boolean {
  const holes = literal && ts.isTemplateExpression(literal) ? literal.templateSpans.length : 0;
  return decodeRaw(text.slice(regionStart, regionEnd), '`').split('${').length - 1 > holes;
}

// --- Context: where the flagged statement is and what runs it
// ------------------------------------------------------

function offsetOf(text: string, line: number, column: number): number | undefined {
  let start = 0;
  for (let row = 1; row < line; row++) {
    start = text.indexOf('\n', start) + 1;
    if (start === 0) return undefined;
  }
  return start + column - 1;
}

function sqlFileFramework(file: string, load: SiteFixInput['load']): string {
  const directory = path.dirname(file);
  if (path.basename(file) === 'migration.sql' && load(path.join(directory, '..', 'migration_lock.toml'))) {
    return 'prisma';
  }
  if (load(path.join(directory, 'meta', '_journal.json'))) return 'drizzle';
  return 'sql';
}

function enclosingLiteral(node: Node): QueryLiteral | undefined {
  return ancestor(
    node,
    (current): current is QueryLiteral =>
      ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current) || ts.isTemplateExpression(current),
  );
}

export function migrationContext({
  finding,
  node,
  sourceFile,
  text,
  load,
}: SiteFixInput): MigrationContext | undefined {
  if (
    typeof text !== 'string' ||
    typeof finding.file !== 'string' ||
    typeof finding.line !== 'number' ||
    typeof finding.column !== 'number'
  )
    return;
  const offset = offsetOf(text, finding.line, finding.column);
  if (offset === undefined) return;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const context: MigrationContext = {
    finding,
    node,
    sourceFile,
    text,
    load,
    offset,
    eol,
    file: finding.file,
    framework: sourceFile ? detectFramework(text) : sqlFileFramework(finding.file, load),
    quote: null,
    regionStart: 0,
    regionEnd: text.length,
    statements: [],
    relativeOffset: 0,
  };
  if (sourceFile) {
    const literal = node && enclosingLiteral(node);
    if (!literal) return context;
    const literalStart = literal.getStart(sourceFile);
    context.literal = literal;
    context.quote = text[literalStart];
    context.regionStart = literalStart + 1;
    context.regionEnd = literal.end - 1;
    if (context.quote === '`' && hasEscapedHole(context)) return;
  }
  const options: ScanOptions = { escapes: Boolean(context.quote), holes: context.quote === '`' };
  context.statements = splitStatements(text, context.regionStart, context.regionEnd, options).map(
    (statement): SqlStatement => {
      const sql = decodeRaw(text.slice(statement.start, statement.end), context.quote);
      return { ...statement, sql, masked: mask(sql, options.holes) };
    },
  );
  context.statement =
    context.statements.find(
      (statement) => statement.start <= offset && offset <= (statement.semicolon ?? statement.end),
    ) ?? context.statements.findLast((statement) => statement.start <= offset);
  if (context.statement) {
    const before = text.slice(context.statement.start, Math.max(offset, context.statement.start));
    context.relativeOffset = decodeRaw(before, context.quote).length;
  }
  return context;
}

// --- Statement anatomy
// ---------------------------------------------------------------------------------------------

export function unquote(name: string): string {
  if (/^".*"$/s.test(name)) return name.slice(1, -1).replaceAll('""', '"');
  if (/^`.*`$/s.test(name)) return name.slice(1, -1).replaceAll('``', '`');
  return name;
}

// The original text of a capture group of a regex (with the `d` flag) that matched the masked SQL.
export function hasIndices(match: RegExpExecArray | null): match is IndexedMatch {
  return match !== null && match.indices !== undefined;
}

export function groupText(sql: string, match: IndexedMatch, index: number): string {
  const range = match.indices[index];
  return range ? sql.slice(range[0], range[1]) : '';
}

export function lastNamePart(qualified: string): string {
  const parts = qualified.match(new RegExp(IDENT, 'g'));
  if (!parts) return qualified;
  return unquote(parts[parts.length - 1]);
}

// `ALTER TABLE t a, b` -> the table text and each comma-separated sub-command as offsets into the
// statement SQL.
export function alterParts(statement: SqlStatement): AlterParts | undefined {
  const header = ALTER_HEADER.exec(statement.masked);
  if (!hasIndices(header)) return;
  const subcommands: SubcommandRange[] = [];
  let from = header[0].length;
  const push = (to: number): void => {
    const text = statement.masked.slice(from, to);
    const start = from + (text.length - text.trimStart().length);
    const end = to - (text.length - text.trimEnd().length);
    if (end > start) subcommands.push({ start, end });
  };
  scanCode(statement.masked, from, statement.masked.length, { escapes: false, holes: false }, (index, char, depth) => {
    if (char !== ',' || depth !== 0) return;
    push(index);
    from = index + 1;
  });
  push(statement.masked.length);
  return { table: groupText(statement.sql, header, 1), subcommands };
}

export function subcommandAt(parts: AlterParts, relativeOffset: number): SubcommandRange {
  return (
    parts.subcommands.find((part) => part.start <= relativeOffset && relativeOffset <= part.end) ?? parts.subcommands[0]
  );
}

export function sliceOf(statement: SqlStatement, part: SubcommandRange): { sql: string; masked: string } {
  return { sql: statement.sql.slice(part.start, part.end), masked: statement.masked.slice(part.start, part.end) };
}

export function splice(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

export function replaceSubcommand(statement: SqlStatement, part: SubcommandRange, replacement: string): string {
  return splice(statement.sql, part.start, part.end, replacement);
}

// The statement without one sub-command and the comma that joined it to its neighbour.
export function withoutSubcommand(statement: SqlStatement, parts: AlterParts, part: SubcommandRange): string {
  const index = parts.subcommands.indexOf(part);
  const start = index === 0 ? part.start : statement.masked.lastIndexOf(',', part.start);
  const end = index === 0 ? parts.subcommands[1].start : part.end;
  return splice(statement.sql, start, end, '');
}
