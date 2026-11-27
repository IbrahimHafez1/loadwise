import path from 'node:path';
import { coverage, fixFor, createIndex, patternIndex, expressionIndex } from './schema/model.js';
import { currentSnapshot } from './schema/context.js';
import { isSeedSource, isToolingSource } from './review-context.js';
import { projectRootOf, projectDialect, migrationIndexes, tableKey } from './schema/project-indexes.js';
import { relativeFile } from './schema/ts-helpers.js';
import type { Node } from 'typescript';
import type { SchemaSnapshot, SnapshotTable } from './types/db-snapshot.js';
import type { DeclarationLink } from './types/declaration-link.js';
import type { MigrationTableEntry } from './types/project-indexes.js';
import type { QueryCondition } from './types/query-site.js';
import type { SchemaIndex, SchemaOrm, SchemaTable } from './types/schema-model.js';

// Below this many rows a scan is cheap; the snapshot's estimate turns a finding contextual.
const smallTableRows = 10_000;

const testSource = /(?:^|[/\\])(?:__tests__|tests?|e2e)[/\\]|\.(?:spec|test|e2e(?:-ee|-spec)?)\.[cm]?[jt]sx?$/i;

const candidateKinds = new Set(['eq', 'in', 'range']);

const selectiveTypes = new Set(['boolean', 'enum', 'bool']);

// Three or more equality filters leave few rows to sort, and the composite they imply is poor
// advice.
export const maxSortedEqualityColumns = 2;

const parentReferenceName = /[a-z0-9](?:Id|_id)$/;

// The table as the rules see it: snapshot indexes win over code, migrations add what entities omit.
export interface TableInfo {
  table: SchemaTable;
  dialect: string | undefined;
  migration: MigrationTableEntry | undefined;
  rows: number | undefined;
  capturedOn: string | undefined;
}

// What a coverage check reads of a condition; foreign keys are checked without a query.
type IndexProbe = Pick<QueryCondition, 'column' | 'kind'> & Partial<Pick<QueryCondition, 'operator' | 'expression'>>;

// The parts of an index the sort and label logic reads, from the model or from a migration.
export interface IndexSummary {
  name?: string;
  keys: { column?: string }[];
  unique?: boolean;
  primary?: boolean;
  predicate?: string | boolean;
}

export interface IndexFixText {
  suggestion: string;
  text: string;
}

const tableInfos = new WeakMap<SchemaTable, { snapshot: SchemaSnapshot | undefined; info: TableInfo }>();

export function ordinal(position: number): string {
  const suffixes: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
  return position + (position > 3 && position < 21 ? 'th' : (suffixes[position % 10] ?? 'th'));
}

function snapshotEntry(snapshot: SchemaSnapshot | undefined, table: SchemaTable): SnapshotTable | undefined {
  if (!snapshot || (table.dialect && snapshot.dialect !== table.dialect)) return;
  const name = table.dbName;
  return snapshot.tables[name] ?? snapshot.tables['public.' + name];
}

function migrationEntry(table: SchemaTable, root: string): MigrationTableEntry | undefined {
  const migrations = migrationIndexes(root);
  const keys = [tableKey(table.dbName), table.name.toLowerCase()];
  return keys.map((key) => migrations.get(key)).find(Boolean);
}

// The table as the rules see it: snapshot indexes win over code, migrations add what entities omit.
export function describe(table: SchemaTable): TableInfo {
  const snapshot = currentSnapshot();
  const cached = tableInfos.get(table);
  if (cached && cached.snapshot === snapshot) return cached.info;
  const root = table.root ?? (table.file ? projectRootOf(table.file) : undefined);
  const dialect = table.dialect ?? (root && projectDialect(root));
  const entry = snapshotEntry(snapshot, table);
  const effective = { ...table, dialect };
  if (entry?.indexes) effective.indexes = entry.indexes.map((index) => createIndex(index));
  const info: TableInfo = {
    table: effective,
    dialect,
    migration: root && table.dialect !== 'mongo' ? migrationEntry(table, root) : undefined,
    rows: entry?.rowEstimate,
    capturedOn: typeof snapshot?.capturedAt === 'string' ? snapshot.capturedAt.slice(0, 10) : undefined,
  };
  tableInfos.set(table, { snapshot, info });
  return info;
}

export function lowerNames(table: SchemaTable, column: string): Set<string> {
  return new Set(
    [column, table.columns.get(column)?.dbName]
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
  );
}

function migrationLeads(info: TableInfo, column: string): boolean {
  const names = lowerNames(info.table, column);
  return (
    info.migration?.indexes.some((index) => {
      const leading = index.keys[0]?.column;
      return leading !== undefined && names.has(leading);
    }) ?? false
  );
}

function migrationMentions(info: TableInfo, column: string): boolean {
  const names = lowerNames(info.table, column);
  return [...names].some((name) => info.migration?.mentioned.has(name));
}

// An index whose first key is one of the column's names.
function startsWithName(index: SchemaIndex, names: ReadonlySet<string>): boolean {
  const leading = index.keys[0]?.column?.toLowerCase();
  return leading !== undefined && names.has(leading);
}

function hashLeads(table: SchemaTable, column: string): boolean {
  const names = lowerNames(table, column);
  return table.indexes.some((index) => index.method === 'hash' && !index.predicate && startsWithName(index, names));
}

// A partial index serves the query only when the query implies its predicate, which is not checked:
// stay silent.
function partialLeads(table: SchemaTable, column: string): boolean {
  const names = lowerNames(table, column);
  return table.indexes.some((index) => index.predicate && startsWithName(index, names));
}

// True when this conjunct can narrow the scan through an index, or might through one the model
// cannot read.
export function isCovering(info: TableInfo, condition: IndexProbe): boolean {
  const { table } = info;
  const { column, kind } = condition;
  // A migration builder whose unique and index options are unread leaves the table's index set
  // unknown.
  if (info.migration?.opaque) return true;
  if (migrationMentions(info, column)) return true;
  if (kind === 'eq' || kind === 'in' || kind === 'null' || kind === 'range') {
    if (coverage(table, column) === 'leading' || migrationLeads(info, column)) return true;
    if (partialLeads(table, column)) return true;
    return kind !== 'range' && hashLeads(table, column);
  }
  if (kind === 'pattern') return hasPatternIndex(info, column);
  if (kind === 'expression') {
    return condition.operator === 'insensitive' ? hasPatternIndex(info, column) : hasExpressionIndex(info, condition);
  }
  if (kind === 'other') {
    const names = lowerNames(table, column);
    return table.indexes.some(
      (index) =>
        (index.method !== 'btree' || index.predicate) &&
        index.keys.some((key) => key.column !== undefined && names.has(key.column.toLowerCase())),
    );
  }
  return false;
}

export function isCandidate(info: TableInfo, condition: QueryCondition): boolean {
  if (!candidateKinds.has(condition.kind)) return false;
  const type = info.table.columns.get(condition.column)?.type?.toLowerCase();
  return !(type !== undefined && selectiveTypes.has(type));
}

export function noun(info: TableInfo): string {
  return info.dialect === 'mongo' ? 'collection' : 'table';
}

export function scanPhrase(info: TableInfo): string {
  if (info.rows === undefined) return `so this lookup scans the ${noun(info)} as it grows`;
  const unit = info.dialect === 'mongo' ? 'documents' : 'rows';
  const source = info.capturedOn
    ? ` (estimated from the snapshot of ${info.capturedOn})`
    : ' (estimated from the snapshot)';
  return `so this lookup scans about ${info.rows.toLocaleString('en-US')} ${unit}${source}`;
}

export function sizeCaveat(info: TableInfo): string {
  if (info.rows !== undefined) return '';
  const label = noun(info) === 'table' ? 'Table' : 'Collection';
  return ` ${label} size is unknown; pass \`--schema\` to gate this rule by row count.`;
}

// Judged inside the owning project, so a project that itself sits under a `test/` folder is not a
// test source.
export function isTestSource(filename: string): boolean {
  const root = projectRootOf(filename);
  return testSource.test(root ? path.relative(root, filename) : filename);
}

// Operator tooling is judged from the parsed file, which a schema file passed by name to
// contextForFile lacks.
export function contextFor(info: TableInfo, node: Node): string | undefined {
  const source = node.getSourceFile();
  const { fileName } = source;
  if (!isTestSource(fileName) && !isSeedSource(fileName) && isToolingSource(source)) {
    return 'Query in operator tooling (scripts, standalone entry points, deployment, migrations or commands).';
  }
  return contextForFile(info, fileName);
}

export function contextForFile(info: TableInfo, filename: string, subject = 'Query'): string | undefined {
  if (isTestSource(filename)) return `${subject} in a test source.`;
  if (isSeedSource(filename)) return `${subject} in seed or demo-data setup.`;
  if (info.rows !== undefined && info.rows < smallTableRows) {
    return `${noun(info) === 'table' ? 'Table' : 'Collection'} has about ${info.rows.toLocaleString('en-US')} rows.`;
  }
}

export function place(table: SchemaTable): string {
  return table.file ? `${relativeFile(table.file)}:${table.line}` : '';
}

// Raw SQL tables known only from a snapshot or by name have no declaration to link.
export function relatedTo(table: SchemaTable): { related?: DeclarationLink[] } {
  return table.file ? { related: [declarationLink(table)] } : {};
}

export function declarationLink(table: SchemaTable): DeclarationLink {
  const kinds: Partial<Record<SchemaOrm, string>> = {
    prisma: 'Model',
    typeorm: 'Entity',
    sequelize: 'Model',
    mongoose: 'Schema',
  };
  const kind = (table.orm && kinds[table.orm]) ?? 'Table';
  return {
    file: relativeFile(table.file ?? ''),
    line: table.line ?? 0,
    column: table.column ?? 1,
    message: `${kind} \`${table.name}\` is declared here.`,
  };
}

function quoted(columns: readonly string[]): string {
  return columns.map((column) => `'${column}'`).join(', ');
}

// The code to add, where to add it, and the DDL a live database needs.
// Query sites and tables always come from an ORM or raw SQL reader that names its source.
function knownOrm(orm: SchemaOrm | undefined): SchemaOrm {
  if (!orm) throw new Error('A table or query without a schema source');
  return orm;
}

export function indexFix(info: TableInfo, columns: string[], schemaSource: SchemaOrm | undefined): IndexFixText {
  const orm = knownOrm(schemaSource);
  const { table } = info;
  const { suggestion: generated, sql, name } = fixFor(table, columns, orm === 'sql' ? 'sql' : 'prisma');
  // Each ORM snippet names the index like the SQL does, so applying both cannot create a duplicate.
  const snippets: Record<SchemaOrm, () => string> = {
    prisma: () => generated,
    drizzle: () => fixFor(table, columns, 'drizzle').suggestion,
    typeorm: () => (columns.length === 1 ? `@Index('${name}')` : `@Index('${name}', [${quoted(columns)}])`),
    sequelize: () => `{ name: '${name}', fields: [${quoted(columns)}] }`,
    mongoose: () =>
      `${table.schemaName ?? 'schema'}.index({ ${columns.map((column) => column + ': 1').join(', ')} }, { name: '${name}' })`,
    sql: () => sql,
  };
  const suggestion = snippets[orm]();
  const where = place(table);
  const targets: Record<SchemaOrm, string> = {
    prisma: `Add \`${suggestion}\` to model \`${table.name}\` (${where})`,
    drizzle: `Add \`${suggestion}\` to the indexes of table \`${table.name}\` (${where})`,
    typeorm:
      columns.length === 1
        ? `Add \`${suggestion}\` to the \`${columns[0]}\` property of entity \`${table.name}\` (${where})`
        : `Add \`${suggestion}\` to entity \`${table.name}\` (${where})`,
    sequelize: `Add \`${suggestion}\` to the \`indexes\` of model \`${table.name}\` (${where})`,
    mongoose: `Add \`${suggestion}\` (${where})`,
    sql: `Create it with \`${suggestion}\``,
  };
  const ddl =
    orm === 'sql' || info.dialect === 'mongo' || !info.dialect ? '' : `; on a live database build it with \`${sql}\``;
  return { suggestion, text: targets[orm] + ddl + '.' };
}

export function nonLeadingIndex(
  table: SchemaTable,
  column: string,
): { index: SchemaIndex; position: number } | undefined {
  const names = lowerNames(table, column);
  for (const index of table.indexes) {
    if (index.method !== 'btree' || index.predicate) continue;
    const position = index.keys.findIndex((key) => key.column !== undefined && names.has(key.column.toLowerCase()));
    if (position > 0) return { index, position };
  }
}

export function indexLabel(index: IndexSummary): string {
  return index.name ? `\`${index.name}\`` : `the index on (${index.keys.map((key) => `\`${key.column}\``).join(', ')})`;
}

export function filterObservation(info: TableInfo, columns: string[]): string {
  const labels = columns.map((column) => `\`${info.table.name}.${column}\``);
  if (columns.length === 1) {
    const partial = nonLeadingIndex(info.table, columns[0]);
    if (partial) {
      return `${labels[0]} is filtered here but is only the ${ordinal(partial.position + 1)} column of ${indexLabel(partial.index)}`;
    }
    return `${labels[0]} is filtered here and no index starts with it`;
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)} are filtered here and no index starts with any of them`;
}

export function labelList(columns: readonly string[]): string {
  const labels = columns.map((column) => `\`${column}\``);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

// A declared foreign key, or a column named like one (`storeId`, `school_id`) when the model
// declares none.
export function isParentReference(table: SchemaTable, column: string): boolean {
  if (table.columns.get(column)?.foreignKey) return true;
  return [column, table.columns.get(column)?.dbName].some((name) => name && parentReferenceName.test(name));
}

// The columns the suggested index keys on. A foreign key already narrows the rows to one parent's,
// so when the filter has one the index keys on the foreign keys alone, not also on wide or barely
// selective columns.
export function indexedColumns(info: TableInfo, filtered: string[]): string[] {
  const foreignKeys = filtered.filter((column) => isParentReference(info.table, column));
  return foreignKeys.length ? foreignKeys : filtered;
}

// Returns true when a finding was reported.
export function infoOf(infos: ReadonlyMap<SchemaTable, TableInfo>, table: SchemaTable): TableInfo {
  const info = infos.get(table);
  if (!info) throw new Error('No table information for ' + table.name);
  return info;
}

export function hasPatternIndex(info: TableInfo, column: string): boolean {
  if (patternIndex(info.table, column)) return true;
  const names = lowerNames(info.table, column);
  return [...names].some((name) => info.migration?.patternColumns.has(name));
}

export function hasExpressionIndex(info: TableInfo, condition: IndexProbe): boolean {
  if (migrationMentions(info, condition.column)) return true;
  const names = lowerNames(info.table, condition.column);
  if ([...names].some((name) => info.migration?.expressionColumns.has(name))) return true;
  if (!condition.expression) return false;
  return expressionIndex(info.table, condition.expression) || expressionIndex(info.table, `(${condition.expression})`);
}
