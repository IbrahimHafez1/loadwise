import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from './context.cjs';
import type { Dirent } from 'node:fs';
import type {
  IndexCreation,
  LiveIndex,
  MigrationDeclarations,
  MigrationTableEntry,
  ParsedKey,
} from '../types/project-indexes.cjs';

interface MigrationEvent {
  /** Character offset of the statement in the migration text. */
  at: number;
  create?: IndexCreation;
  drop?: (string | undefined)[];
  dropTables?: string[];
  rename?: { from: string; to: string };
  dropColumns?: { table: string; columns: string[] };
  /** A table changed through a builder whose index options are not read. */
  opaque?: string;
}

interface NamedIndex {
  name?: string;
  spelling?: string;
}

interface TextRange {
  start: number;
  end: number;
}

interface MigrationScan {
  directories: string[];
  stamp: string;
  tables: Map<string, MigrationTableEntry>;
  live: LiveIndex[];
  opaqueTables: Set<string>;
}

interface CachedScan {
  result: MigrationScan;
  checkedAt: number;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const postgresDrivers = ['pg', 'postgres', 'pg-promise', '@neondatabase/serverless', '@vercel/postgres'];
const mysqlDrivers = ['mysql', 'mysql2', 'mariadb'];
const skippedDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const migrationDirectory = /^migrations?$/i;
const migrationFile = /\.(?:sql|[cm]?[jt]s)$/;
// Migration folders sit near the project root; deeper trees are vendored code or build output.
const maxSearchDepth = 6;
// A generated dump this large is not a hand-written migration and would slow every scan.
const maxMigrationBytes = 2 * 1024 * 1024;
const revalidateAfterMilliseconds = 2000;
const roots = new Map<string, string>();
const migrationCache = new Map<string, CachedScan>();

// The project that owns a file; generated clients inside node_modules belong to the project around
// them.
function projectRootOf(filename: string): string {
  const normalized = filename.replaceAll('\\', '/');
  const marker = normalized.indexOf('/node_modules/');
  const start = marker < 0 ? path.dirname(filename) : normalized.slice(0, marker);
  const known = roots.get(start);
  if (known !== undefined) return known;
  const root = findProjectRoot(start);
  roots.set(start, root);
  return root;
}

function readManifest(root: string): PackageManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

// A project with exactly one family of SQL drivers; anything else is ambiguous.
function projectDialect(root: string): 'postgres' | 'mysql' | undefined {
  const manifest = readManifest(root);
  const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
  const postgres = postgresDrivers.some((name) => Object.hasOwn(dependencies, name));
  const mysql = mysqlDrivers.some((name) => Object.hasOwn(dependencies, name));
  if (postgres !== mysql) return postgres ? 'postgres' : 'mysql';
}

function unquote(identifier: string): string {
  return identifier.trim().replaceAll(/^[`"[]|[`"\]]$/g, '');
}

// The table's own name as written, without its schema and quotes.
function tableSpelling(name: string): string {
  return unquote(name.split('.').at(-1) ?? '');
}

function tableKey(name: string): string {
  return tableSpelling(name).toLowerCase();
}

// The name the database stores: PostgreSQL folds an unquoted identifier to lower case and keeps a
// quoted one as written. MySQL compares index and column names case-insensitively, so the same
// spelling works there.
function identifierSpelling(identifier: string): string {
  const lastPart = (identifier.split('.').at(-1) ?? '').trim();
  return /^[`"[]/.test(lastPart) ? unquote(lastPart) : lastPart.toLowerCase();
}

function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')' && --depth === 0) return index;
  }
  return -1;
}

// Splits on commas outside parentheses, brackets and braces, so it also splits a call's argument
// list.
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if ('([{'.includes(text[index])) depth++;
    else if (')]}'.includes(text[index])) depth--;
    else if (text[index] === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

// `"col" text_pattern_ops DESC` -> { column, opclass }; anything with parentheses is an expression.
function readKey(item: string): ParsedKey {
  if (item.includes('(')) {
    const columns = [...item.matchAll(/[`"]?([A-Za-z_]\w*)[`"]?/g)].map((match) => match[1].toLowerCase());
    return { expression: item, columns };
  }
  const [name, ...rest] = item.split(/\s+/);
  const opclass = rest.find((word) => !/^(?:asc|desc|nulls|first|last|collate)$/i.test(word));
  // Order and collation do not change coverage, but they decide whether one index can stand in for
  // another.
  const ordering = rest.filter((word) => /^(?:desc|nulls|first|last|collate)$/i.test(word)).join(' ');
  return {
    column: unquote(name).toLowerCase(),
    spelling: identifierSpelling(name),
    opclass: opclass?.toLowerCase(),
    ordering: ordering || undefined,
  };
}

function indexName(identifier: string | undefined): string | undefined {
  return identifier ? tableKey(identifier) : undefined;
}

// An index's lower-case `name`, which drops match, and its `spelling` in the database, which
// messages show.
function namedIndex(identifier: string | undefined): NamedIndex {
  return identifier ? { name: indexName(identifier), spelling: identifierSpelling(identifier) } : {};
}

function entryFor(tables: Map<string, MigrationTableEntry>, name: string): MigrationTableEntry {
  const key = tableKey(name);
  const existing = tables.get(key);
  if (existing) return existing;
  const created: MigrationTableEntry = {
    opaque: false,
    indexes: [],
    others: [],
    mentioned: new Set(),
    expressionColumns: new Set(),
    patternColumns: new Set(),
  };
  tables.set(key, created);
  return created;
}

// A plain btree over columns counts as coverage; partial and other methods only silence rules,
// through
// `mentioned` (any plain column they touch) and `others` (their key lists). Columns inside
// expression keys go to
// `expressionColumns` instead, because a plain filter on the column cannot use such an index.
function recordIndex(
  tables: Map<string, MigrationTableEntry>,
  { table, keys, unique, method = 'btree', partial }: IndexCreation,
): void {
  const entry = entryFor(tables, table);
  for (const key of keys) {
    if (key.column && /_trgm_ops$|_pattern_ops$/.test(key.opclass ?? '')) entry.patternColumns.add(key.column);
  }
  if (method.toLowerCase() === 'btree' && !partial && keys.every((key) => key.column && !key.opclass)) {
    entry.indexes.push({ keys: keys.map((key) => ({ column: key.column })), unique, primary: false, method: 'btree' });
    return;
  }
  entry.others.push({ keys: keys.map((key) => ({ column: key.column, columns: key.columns })), method, partial });
  for (const key of keys) {
    if (key.column) entry.mentioned.add(key.column);
    for (const column of key.columns ?? []) entry.expressionColumns.add(column);
  }
}

const createIndexPattern =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:([`"\w.]+)\s+)?ON\s+(?:ONLY\s+)?([`"\w.]+)\s*(?:USING\s+(\w+)\s*)?\(/gi;
const alterTablePattern = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([`"\w.]+)\s+([^;]*)/gi;
const addColumnPattern = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i;
// An `ADD` that adds a key rather than a column; those are read by the constraint patterns.
const keyDefinition = /^(?:UNIQUE|PRIMARY|INDEX|KEY|FULLTEXT|SPATIAL|EXCLUDE)\b/i;
const builderTablePattern =
  /\b(?:createTable|alterTable|addConstraint|table|new\s+Table)\s*\(\s*(?:\{\s*name\s*:\s*)?['"`]([\w.]+)['"`]/g;
const indexingBuilderOption =
  /\b(?:unique|isUnique|indices|uniques|fulltext|addConstraint|createUniqueConstraint)\b|\.(?:index|primary)\s*\(/i;
const alterConstraintPattern =
  /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([`"\w.]+)\s+ADD\s+(?:CONSTRAINT\s+([`"\w]+)\s+)?(UNIQUE(?:\s+(?:KEY|INDEX))?|PRIMARY\s+KEY|INDEX|KEY)\s*(?:([`"\w]+)\s*)?\(/gi;
const createTablePattern =
  /CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.]+)\s*\(/gi;
// A table-level `[CONSTRAINT name] UNIQUE [KEY|INDEX] [name] (...)` or `PRIMARY KEY (...)` inside
// CREATE TABLE.
const tableConstraintPattern =
  /^(?:CONSTRAINT\s+([`"\w]+)\s+)?(UNIQUE(?:\s+(?:KEY|INDEX))?|PRIMARY\s+KEY)\s*(?:([`"\w]+)\s*)?\(/i;
// Definitions inside CREATE TABLE that are not columns.
const nonColumnDefinition = /^(?:CONSTRAINT|CHECK|FOREIGN|EXCLUDE|LIKE|INDEX|KEY|FULLTEXT|SPATIAL|PERIOD)\b/i;
// Sequelize `addIndex`, n8n's migration DSL and TypeORM's `queryRunner.createIndex` share this call
// shape.
const addIndexPattern = /\b(?:addIndex|createIndex)\(\s*['"`]([\w.]+)['"`]\s*,/g;
const removeIndexPattern = /\b(?:removeIndex|dropIndex)\(\s*['"`]([\w.]+)['"`]\s*,/g;
// n8n's `createTable('name')...withIndexOn(...)` chain; a chain ends at the statement's semicolon.
const createTableChainPattern = /\bcreateTable\(\s*['"`]([\w.]+)['"`]\s*\)/g;
const chainIndexPattern = /\.(withIndexOn|withUniqueConstraintOn)\(/g;
// `DROP INDEX "${name}"`: the name comes from a variable, typically a loop over a list of names in
// the file.
const dynamicDropIndexPattern = /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?[`"]?\$\{/gi;
// `DROP INDEX [CONCURRENTLY] [IF EXISTS] a, b`; MySQL's trailing `ON table` is not part of the name
// list.
const dropIndexPattern = /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([`"\w.]+(?:\s*,\s*[`"\w.]+)*)/gi;
const dropConstraintPattern =
  /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?[`"\w.]+\s+DROP\s+(?:CONSTRAINT|KEY)\s+(?:IF\s+EXISTS\s+)?([`"\w]+)/gi;
// `DROP TABLE [IF EXISTS] a, "s"."b"` and the `dropTable('a')` helpers of knex, Sequelize and
// TypeORM take the table's indexes with it.
const dropTablePattern = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"\w.]+(?:\s*,\s*[`"\w.]+)*)/gi;
const dropTableCallPattern = /\b(?:dropTable|dropTableIfExists)\(\s*['"`]([\w.]+)['"`]/g;
const renameTablePattern =
  /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([`"\w.]+)\s+RENAME\s+(?:TO|AS)\s+([`"\w.]+)/gi;
// MySQL `RENAME TABLE a TO b, c TO d`; each pair is read on its own.
const renameTableStatementPattern = /\bRENAME\s+TABLE\s+([^;]+)/gi;
const renamePairPattern = /^([`"\w.]+)\s+TO\s+([`"\w.]+)/i;
// `DROP [COLUMN] [IF EXISTS] c` inside ALTER TABLE; without COLUMN, the other `DROP <object>` forms
// are not columns.
const dropColumnClausePattern =
  /^DROP\s+(?:COLUMN\s+(?:IF\s+EXISTS\s+)?|(?!(?:CONSTRAINT|KEY|INDEX|PRIMARY|FOREIGN|CHECK|IF)\b))([`"\w]+)/i;
// knex `dropColumn('a')` / `dropColumns('a', 'b')` inside a table builder's callback.
const dropColumnCallPattern = /\bdropColumns?\(([^)]*)\)/g;
// TypeORM `queryRunner.dropColumn('t', 'c' | new TableColumn({ name: 'c' }))` and `dropColumns('t',
// [...])`; the receiver is required because knex's `dropColumns('a', 'b')` names columns only.
const queryRunnerDropColumnPattern = /\bqueryRunner\s*\.\s*dropColumns?\(\s*['"`]([\w.]+)['"`]\s*,/g;
const columnNameOption = /\bname\s*:\s*['"`](\w+)['"`]/g;
// The start of a code migration's step: `down(`, `async down(`, `down: async (` or `exports.down =
// function`.
const rollbackStart = /\bdown\s*(?:\(|[:=]\s*(?:async\b|function\b|\())/;
const forwardStart = /\bup\s*(?:\(|[:=]\s*(?:async\b|function\b|\())/;

// The character range of a code migration's `down` step. It undoes the migration and never runs on
// a migrated database, so its statements must not count. SQL files have no such step.
function rollbackRange(text: string, filename: string): TextRange | undefined {
  if (filename.endsWith('.sql')) return;
  const down = rollbackStart.exec(text);
  if (!down) return;
  const up = forwardStart.exec(text);
  return { start: down.index, end: up && up.index > down.index ? up.index : text.length };
}

// A string literal from its opening quote: backticks and SQL strings may span lines, a code string
// ends at its line so a stray quote in a regex literal cannot swallow the rest of the file.
function stringLiteralEnd(text: string, start: number, multiline: boolean | 'sql'): number {
  const quote = text[start];
  for (let position = start + 1; position < text.length; position++) {
    const character = text[position];
    if (character === '\n' && !multiline) return position;
    if (character === '\\' && multiline !== 'sql') position++;
    else if (character === quote) {
      if (multiline === 'sql' && text[position + 1] === quote) position++;
      else return position + 1;
    }
  }
  return text.length;
}

// The text with every comment blanked out, newlines and offsets kept, so a commented-out statement
// cannot count as schema. Strings are skipped so a `//` or `--` inside one is not taken for a
// comment.
function withoutComments(text: string, filename: string): string {
  const sql = filename.endsWith('.sql');
  const lineComment = sql ? '--' : '//';
  let result = '';
  let position = 0;
  while (position < text.length) {
    let end: number | undefined;
    if (text.startsWith(lineComment, position)) {
      const newline = text.indexOf('\n', position);
      end = newline < 0 ? text.length : newline;
    } else if (text.startsWith('/*', position)) {
      const close = text.indexOf('*/', position + 2);
      end = close < 0 ? text.length : close + 2;
    }
    if (end !== undefined) {
      result += text.slice(position, end).replaceAll(/[^\n]/g, ' ');
      position = end;
      continue;
    }
    const character = text[position];
    if (character === "'" || character === '"' || character === '`') {
      const multiline: boolean | 'sql' = sql ? 'sql' : character === '`';
      end = stringLiteralEnd(text, position, multiline);
      result += text.slice(position, end);
      position = end;
      continue;
    }
    result += character;
    position++;
  }
  return result;
}

function createEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(createIndexPattern)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    const keys = splitTopLevel(text.slice(open + 1, close)).map(readKey);
    const tail = text.slice(close + 1, close + 200);
    const partial = /^\s*(?:INCLUDE\s*\([^)]*\)\s*)?(?:WITH\s*\([^)]*\)\s*)?WHERE\b/i.test(tail);
    const unique = Boolean(match[1]);
    events.push({
      at: match.index,
      create: { table: match[3], ...namedIndex(match[2]), keys, unique, method: match[4], partial },
    });
  }
  for (const match of text.matchAll(alterConstraintPattern)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    const keys = splitTopLevel(text.slice(open + 1, close)).map(readKey);
    const unique = /UNIQUE|PRIMARY/i.test(match[3]);
    // A constraint's index is removed with DROP CONSTRAINT, not DROP INDEX.
    const constraint = Boolean(match[2]) || /^(?:UNIQUE|PRIMARY\s+KEY)$/i.test(match[3]);
    events.push({
      at: match.index,
      create: {
        table: match[1],
        ...namedIndex(match[2] ?? match[4]),
        keys,
        unique,
        constraint,
        primary: /PRIMARY/i.test(match[3]),
      },
    });
  }
  return events;
}

// A column definition's own `UNIQUE` or `PRIMARY KEY`, read with parenthesized parts and string
// literals removed so a CHECK, DEFAULT or REFERENCES clause cannot supply the keyword.
function columnConstraint(
  definition: string,
): (NamedIndex & { keys: ParsedKey[]; constraint: boolean; primary: boolean }) | undefined {
  if (nonColumnDefinition.test(definition)) return;
  const column = /^([`"]?)(\w+)\1\s/.exec(definition);
  if (!column) return;
  const bare = definition.replaceAll(/'(?:[^']|'')*'/g, "''").replaceAll(/\([^()]*\)/g, '()');
  const constraint = /(?:\bCONSTRAINT\s+([`"\w]+)\s+)?\b(UNIQUE|PRIMARY\s+KEY)\b/i.exec(bare);
  if (!constraint) return;
  const keys = [{ column: column[2].toLowerCase(), spelling: identifierSpelling(column[0]) }];
  return { ...namedIndex(constraint[1]), keys, constraint: true, primary: /PRIMARY/i.test(constraint[2]) };
}

function tableConstraint(
  definition: string,
): (NamedIndex & { keys: ParsedKey[]; constraint: boolean; primary: boolean }) | undefined {
  const match = tableConstraintPattern.exec(definition);
  if (!match) return;
  const open = match[0].length - 1;
  const close = closingParenthesis(definition, open);
  if (close < 0) return;
  const keys = splitTopLevel(definition.slice(open + 1, close)).map(readKey);
  return { ...namedIndex(match[1] ?? match[3]), keys, constraint: true, primary: /PRIMARY/i.test(match[2]) };
}

// `CREATE TABLE t (..., UNIQUE (a, b), PRIMARY KEY (id))` and column-level `UNIQUE` / `PRIMARY
// KEY`: each is a unique btree index on the new table.
function createTableEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(createTablePattern)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    for (const definition of splitTopLevel(text.slice(open + 1, close))) {
      const constraint = tableConstraint(definition) ?? columnConstraint(definition);
      if (constraint) events.push({ at: match.index, create: { table: match[1], ...constraint, unique: true } });
    }
  }
  return events;
}

// `ALTER TABLE t ADD COLUMN c text UNIQUE`: the column's own constraint is a unique index, like in
// CREATE TABLE.
function alterColumnEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(alterTablePattern)) {
    for (const clause of splitTopLevel(match[2])) {
      const definition = addColumnPattern.exec(clause)?.[1];
      if (!definition || keyDefinition.test(definition)) continue;
      const constraint = columnConstraint(definition);
      if (constraint) events.push({ at: match.index, create: { table: match[1], ...constraint, unique: true } });
    }
  }
  return events;
}

// Tables a code migration changes through a builder whose unique or index options this scan does
// not read (`knex.schema.alterTable('t', ...)`, Sequelize `createTable`, TypeORM `new Table({ name
// })`). Their index set is unknown, so rules stay silent on them.
function builderTables(text: string): { at: number; table: string }[] {
  const tables: { at: number; table: string }[] = [];
  for (const match of text.matchAll(builderTablePattern)) {
    const open = match.index + match[0].indexOf('(');
    const close = closingParenthesis(text, open);
    if (close >= 0 && indexingBuilderOption.test(text.slice(open, close))) {
      tables.push({ at: match.index, table: match[1] });
    }
  }
  return tables;
}

function dropEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(dropIndexPattern)) {
    events.push({ at: match.index, drop: match[1].split(',').map(indexName) });
  }
  for (const match of text.matchAll(dropConstraintPattern)) {
    events.push({ at: match.index, drop: [indexName(match[1])] });
  }
  // The variable's values are unknown, so every identifier-like string literal in the file counts
  // as dropped.
  const literals = [...text.matchAll(/['"](\w+)['"]/g)].map((literal) => literal[1].toLowerCase());
  for (const match of text.matchAll(dynamicDropIndexPattern)) {
    events.push({ at: match.index, drop: literals });
  }
  return events;
}

// Dropped and renamed tables; their indexes go with them or move to the new name.
function tableEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(dropTablePattern)) {
    events.push({ at: match.index, dropTables: match[1].split(',').map(tableKey) });
  }
  for (const match of text.matchAll(dropTableCallPattern)) {
    events.push({ at: match.index, dropTables: [tableKey(match[1])] });
  }
  for (const match of text.matchAll(renameTablePattern)) {
    events.push({ at: match.index, rename: { from: tableKey(match[1]), to: match[2] } });
  }
  for (const match of text.matchAll(renameTableStatementPattern)) {
    for (const pair of splitTopLevel(match[1])) {
      const names = renamePairPattern.exec(pair);
      if (names) events.push({ at: match.index, rename: { from: tableKey(names[1]), to: names[2] } });
    }
  }
  return events;
}

// A dropped column takes every index that includes it, so none can be named by a later finding.
function dropColumnEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(alterTablePattern)) {
    const columns = splitTopLevel(match[2])
      .map((clause) => dropColumnClausePattern.exec(clause)?.[1])
      .filter((column): column is string => column !== undefined)
      .map((column) => unquote(column).toLowerCase());
    if (columns.length) events.push({ at: match.index, dropColumns: { table: tableKey(match[1]), columns } });
  }
  for (const match of text.matchAll(builderTablePattern)) {
    const open = match.index + match[0].indexOf('(');
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    for (const call of text.slice(open, close).matchAll(dropColumnCallPattern)) {
      events.push({ at: match.index, dropColumns: { table: tableKey(match[1]), columns: quotedColumns(call[1]) } });
    }
  }
  for (const match of text.matchAll(queryRunnerDropColumnPattern)) {
    const open = match.index + match[0].indexOf('(');
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    const target = text.slice(match.index + match[0].length, close);
    const named = [...target.matchAll(columnNameOption)].map((option) => option[1].toLowerCase());
    events.push({
      at: match.index,
      dropColumns: { table: tableKey(match[1]), columns: named.length ? named : quotedColumns(target) },
    });
  }
  return events;
}

// The name a code helper gives an index created or dropped by table and columns, when no explicit
// name is known. The parentheses keep it apart from real index names.
function columnListName(table: string, columns: string[]): string {
  return `${tableKey(table)}(${columns.join(',')})`;
}

function quotedColumns(list: string): string[] {
  return [...list.matchAll(/['"`](\w+)['"`]/g)].map((item) => item[1].toLowerCase());
}

function stringLiteral(argument: string | undefined): string | undefined {
  return /^['"`](\w+)['"`]$/.exec(argument?.trim() ?? '')?.[1];
}

// Sequelize `queryInterface.addIndex('Table', ['a', 'b'], { ... })` or `addIndex('Table', { fields:
// [...] })`, TypeORM `queryRunner.createIndex('table', new TableIndex({ columnNames: [...] }))` and
// n8n's DSL
// `createIndex('table', ['a'], isUnique, customIndexName, whereClause)`.
function addIndexEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(addIndexPattern)) {
    const open = match.index + match[0].indexOf('(');
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    const call = text.slice(open + 1, close);
    const list = /\[([^\]]*)\]/.exec(call.slice(call.indexOf(',') + 1));
    if (!list) continue;
    const keys = [...list[1].matchAll(/['"`](\w+)['"`]/g)].map((item) => ({
      column: item[1].toLowerCase(),
      spelling: item[1],
    }));
    if (!keys.length) continue;
    const columns = keys.map((key) => key.column);
    // Object fields (`{ name: 'a', order: 'DESC' }`) carry ordering that the quoted-name scan
    // cannot read.
    const plainKeys = !list[1].includes('{');
    const [, , positionalUnique, positionalName, positionalWhere] = splitTopLevel(call);
    const special =
      /\bwhere\b|\busing\b|\boperator\b|fulltext/i.test(call) ||
      (positionalWhere !== undefined && positionalWhere !== 'undefined');
    const unique = /unique\s*:\s*true/i.test(call) || positionalUnique === 'true';
    const explicitName = /\bname\s*:\s*['"`](\w+)['"`]/.exec(call)?.[1] ?? stringLiteral(positionalName);
    // These helpers quote the names they are given, so an explicit name is stored as written.
    const naming = explicitName
      ? { name: indexName(explicitName), spelling: explicitName }
      : { name: columnListName(match[1], columns) };
    events.push({ at: match.index, create: { table: match[1], ...naming, keys, unique, partial: special, plainKeys } });
  }
  return events;
}

// `removeIndex('table', 'name')` / `dropIndex('table', 'name')` drop by name; with a column list
// they drop the index that `columnListName` named, or n8n's `{ customIndexName }`.
function removeIndexEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(removeIndexPattern)) {
    const open = match.index + match[0].indexOf('(');
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    const [, target, options] = splitTopLevel(text.slice(open + 1, close));
    const namedTarget = stringLiteral(target);
    if (namedTarget) {
      events.push({ at: match.index, drop: [indexName(namedTarget)] });
      continue;
    }
    if (!target?.startsWith('[')) continue;
    const drop: (string | undefined)[] = [columnListName(match[1], quotedColumns(target))];
    const customName = /\bcustomIndexName\s*:\s*['"`](\w+)['"`]/.exec(options ?? '')?.[1];
    if (customName) drop.push(indexName(customName));
    events.push({ at: match.index, drop });
  }
  return events;
}

// n8n's `createTable('table').withColumns(...).withIndexOn(['a', 'b'],
// true).withUniqueConstraintOn('c')`.
function createTableChainEvents(text: string): MigrationEvent[] {
  const events: MigrationEvent[] = [];
  for (const match of text.matchAll(createTableChainPattern)) {
    const end = text.indexOf(';', match.index);
    const chain = text.slice(match.index, end < 0 ? text.length : end);
    for (const call of chain.matchAll(chainIndexPattern)) {
      const open = call.index + call[0].length - 1;
      const close = closingParenthesis(chain, open);
      if (close < 0) continue;
      const [columnsArgument, uniqueArgument] = splitTopLevel(chain.slice(open + 1, close));
      const columns = quotedColumns(columnsArgument ?? '');
      if (!columns.length) continue;
      const unique = call[1] === 'withUniqueConstraintOn' || uniqueArgument === 'true';
      events.push({
        at: match.index,
        create: {
          table: match[1],
          name: columnListName(match[1], columns),
          keys: columns.map((column) => ({ column })),
          unique,
        },
      });
    }
  }
  return events;
}

// One migration file's index creates and drops in text order, leaving out its rollback step.
function migrationEvents(source: string, filename: string): MigrationEvent[] {
  const text = withoutComments(source, filename);
  const rollback = rollbackRange(text, filename);
  const inRollback = (event: MigrationEvent) => rollback && event.at >= rollback.start && event.at < rollback.end;
  return [
    ...createEvents(text),
    ...createTableEvents(text),
    ...alterColumnEvents(text),
    ...builderTables(text).map(({ at, table }) => ({ at, opaque: table })),
    ...dropEvents(text),
    ...tableEvents(text),
    ...dropColumnEvents(text),
    ...addIndexEvents(text),
    ...removeIndexEvents(text),
    ...createTableChainEvents(text),
  ]
    .filter((event) => !inRollback(event))
    .sort((left, right) => left.at - right.at);
}

function migrationDirectories(root: string): string[] {
  const found: string[] = [];
  function visit(directory: string, depth: number): void {
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skippedDirectories.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (migrationDirectory.test(entry.name)) found.push(child);
      else if (depth < maxSearchDepth) visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return found;
}

// A folder can disappear between discovery and reading (another process cleaning up); it then has
// no files.
function entriesOf(directory: string): Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

// A `baseline` folder holds the schema the dated migrations start from, so it replays first. Node
// before 20.12 names a directory entry's folder `path`, which the current typings no longer
// declare.
function direntFolder(entry: Dirent): string {
  if (entry.parentPath !== undefined) return entry.parentPath;
  return 'path' in entry && typeof entry.path === 'string' ? entry.path : '';
}

function isBaseline(filename: string) {
  return filename.split(/[\\/]/).includes('baseline');
}

function compareReplayOrder(left: string, right: string): number {
  const baselineOrder = Number(isBaseline(right)) - Number(isBaseline(left));
  if (baselineOrder) return baselineOrder;
  return left < right ? -1 : left > right ? 1 : 0;
}

function migrationFiles(directories: string[]): string[] {
  return directories.flatMap((directory: string) =>
    entriesOf(directory)
      .filter((entry) => entry.isFile() && migrationFile.test(entry.name) && !entry.name.endsWith('.d.ts'))
      .map((entry) => path.join(direntFolder(entry), entry.name))
      .sort(compareReplayOrder),
  );
}

function stamp(directories: string[]): string {
  return directories
    .map((directory: string) => directory + ':' + (fs.statSync(directory, { throwIfNoEntry: false })?.mtimeMs ?? -1))
    .join('|');
}

// The innermost migrations folder holding a file; tables with the same name in different folders
// are unrelated.
function owningDirectory(directories: string[], filename: string): string | undefined {
  return directories
    .filter((directory: string) => filename.startsWith(directory))
    .sort((a, b) => b.length - a.length)[0];
}

function indexIncludesColumn(index: LiveIndex, columns: string[]): boolean {
  return index.keys.some(
    (key) =>
      (key.column !== undefined && columns.includes(key.column)) ||
      key.columns?.some((column) => columns.includes(column)),
  );
}

function scanMigrations(root: string): MigrationScan {
  const directories = migrationDirectories(root);
  // Indexes in creation order; a later drop removes those with its name.
  let live: LiveIndex[] = [];
  const opaqueTables = new Set<string>();
  for (const filename of migrationFiles(directories)) {
    const size = fs.statSync(filename, { throwIfNoEntry: false })?.size ?? 0;
    if (size > maxMigrationBytes) continue;
    const directory = owningDirectory(directories, filename);
    // A dropped or renamed table is the one created in the same migrations folder.
    const onTable = (index: LiveIndex, table: string) =>
      index.directory === directory && tableKey(index.table) === table;
    for (const event of migrationEvents(fs.readFileSync(filename, 'utf8'), filename)) {
      const { create, dropTables, drop } = event;
      if (event.opaque) opaqueTables.add(tableKey(event.opaque));
      else if (create) {
        // An index of the same name on the table is replaced, not added next to itself.
        if (create.name) {
          live = live.filter(
            (index) =>
              index.name !== create.name ||
              index.directory !== directory ||
              tableKey(index.table) !== tableKey(create.table),
          );
        }
        live.push({ ...create, file: filename, at: event.at, directory });
      } else if (dropTables) {
        live = live.filter((index) => !dropTables.some((table) => onTable(index, table)));
      } else if (event.dropColumns) {
        const { table, columns } = event.dropColumns;
        live = live.filter((index) => !onTable(index, table) || !indexIncludesColumn(index, columns));
      } else if (event.rename) {
        for (const index of live) if (onTable(index, event.rename.from)) index.table = event.rename.to;
      } else live = live.filter((index) => !index.name || !(drop ?? []).includes(index.name));
    }
  }
  const tables = new Map<string, MigrationTableEntry>();
  for (const index of live) recordIndex(tables, index);
  for (const table of opaqueTables) entryFor(tables, table).opaque = true;
  return { directories, stamp: stamp(directories), tables, live, opaqueTables };
}

function migrationScan(root: string): MigrationScan {
  const cached = migrationCache.get(root);
  const now = Date.now();
  if (cached && now - cached.checkedAt < revalidateAfterMilliseconds) return cached.result;
  if (cached && stamp(cached.result.directories) === cached.result.stamp) {
    cached.checkedAt = now;
    return cached.result;
  }
  const result = scanMigrations(root);
  migrationCache.set(root, { result, checkedAt: now });
  return result;
}

// Indexes that migrations create, keyed by lower-case table name. Entities in TypeORM-style
// projects often omit indexes that a hand-written migration adds, so these silence the rules rather
// than being trusted blindly.
function migrationIndexes(root: string): Map<string, MigrationTableEntry> {
  return migrationScan(root).tables;
}

// The indexes still live after every migration, each with its file and character offset, for rules
// that report at the declaration. `opaqueTables` lists tables whose index set is not fully read.
function migrationDeclarations(root: string): MigrationDeclarations {
  const { live, opaqueTables } = migrationScan(root);
  return { indexes: live, opaqueTables };
}

export {
  direntFolder,
  projectRootOf,
  projectDialect,
  migrationIndexes,
  migrationDeclarations,
  tableKey,
  tableSpelling,
};
