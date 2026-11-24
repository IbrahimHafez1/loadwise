import path from 'node:path';
import { loadSyntax } from './compiler.cjs';
import { allDefined, coverage, fixFor, createIndex, patternIndex, expressionIndex } from './schema/model.cjs';
import { currentSnapshot } from './schema/context.cjs';
import { querySite } from './schema/query-sites.cjs';
import { rawSqlSite } from './schema/raw-sql-sites.cjs';
import { isSeedSource, isToolingSource } from './review-context.cjs';
import { projectRootOf, projectDialect, migrationIndexes, tableKey } from './schema/project-indexes.cjs';
import { relativeFile, calleeName, propertyName, declaredInPackage } from './schema/ts-helpers.cjs';
import { drizzleTableFromCall } from './schema/drizzle-schema.cjs';
import { typeormTable } from './schema/typeorm-schema.cjs';
import { sequelizeTableOf } from './schema/sequelize-schema.cjs';
import { checkRedundantIndexes } from './redundant-indexes.cjs';
import type { CallExpression, Node } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.cjs';
import type { SchemaSnapshot, SnapshotTable } from './types/db-snapshot.cjs';
import type { DeclarationLink } from './types/declaration-link.cjs';
import type { MigrationTableEntry } from './types/project-indexes.cjs';
import type { QueryCondition, QuerySite } from './types/query-site.cjs';
import type { SchemaIndex, SchemaOrm, SchemaTable } from './types/schema-model.cjs';
const ts = loadSyntax();

// Below this many rows a scan is cheap; the snapshot's estimate turns a finding contextual.
const smallTableRows = 10_000;
const testSource = /(?:^|[/\\])(?:__tests__|tests?|e2e)[/\\]|\.(?:spec|test|e2e(?:-ee|-spec)?)\.[cm]?[jt]sx?$/i;
const candidateKinds = new Set(['eq', 'in', 'range']);
const selectiveTypes = new Set(['boolean', 'enum', 'bool']);
// Three or more equality filters leave few rows to sort, and the composite they imply is poor
// advice.
const maxSortedEqualityColumns = 2;
const parentReferenceName = /[a-z0-9](?:Id|_id)$/;

// The table as the rules see it: snapshot indexes win over code, migrations add what entities omit.
interface TableInfo {
  table: SchemaTable;
  dialect: string | undefined;
  migration: MigrationTableEntry | undefined;
  rows: number | undefined;
  capturedOn: string | undefined;
}

// What a coverage check reads of a condition; foreign keys are checked without a query.
type IndexProbe = Pick<QueryCondition, 'column' | 'kind'> & Partial<Pick<QueryCondition, 'operator' | 'expression'>>;

// The parts of an index the sort and label logic reads, from the model or from a migration.
interface IndexSummary {
  name?: string;
  keys: { column?: string }[];
  unique?: boolean;
  primary?: boolean;
  predicate?: string | boolean;
}

// An index with its key columns in lower case.
interface OrderableIndex {
  index: IndexSummary;
  keys: string[];
}

// A limited, sorted read that no index serves.
interface OrderGap {
  info: TableInfo;
  equalityColumns: string[];
  sortColumns: string[];
  columns: string[];
  node: Node;
  replaced: IndexSummary | undefined;
  narrowedBy: string | undefined;
}

interface IndexFixText {
  suggestion: string;
  text: string;
}

interface ForeignKeyFinding {
  message: string;
  suggestion: string;
  contextualReason: string | undefined;
}

const tableInfos = new WeakMap<SchemaTable, { snapshot: SchemaSnapshot | undefined; info: TableInfo }>();

function ordinal(position: number): string {
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
function describe(table: SchemaTable): TableInfo {
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

function lowerNames(table: SchemaTable, column: string): Set<string> {
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
function isCovering(info: TableInfo, condition: IndexProbe): boolean {
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

function isCandidate(info: TableInfo, condition: QueryCondition): boolean {
  if (!candidateKinds.has(condition.kind)) return false;
  const type = info.table.columns.get(condition.column)?.type?.toLowerCase();
  return !(type !== undefined && selectiveTypes.has(type));
}

function noun(info: TableInfo): string {
  return info.dialect === 'mongo' ? 'collection' : 'table';
}

function scanPhrase(info: TableInfo): string {
  if (info.rows === undefined) return `so this lookup scans the ${noun(info)} as it grows`;
  const unit = info.dialect === 'mongo' ? 'documents' : 'rows';
  const source = info.capturedOn
    ? ` (estimated from the snapshot of ${info.capturedOn})`
    : ' (estimated from the snapshot)';
  return `so this lookup scans about ${info.rows.toLocaleString('en-US')} ${unit}${source}`;
}

function sizeCaveat(info: TableInfo): string {
  if (info.rows !== undefined) return '';
  const label = noun(info) === 'table' ? 'Table' : 'Collection';
  return ` ${label} size is unknown; pass \`--schema\` to gate this rule by row count.`;
}

// Judged inside the owning project, so a project that itself sits under a `test/` folder is not a
// test source.
function isTestSource(filename: string): boolean {
  const root = projectRootOf(filename);
  return testSource.test(root ? path.relative(root, filename) : filename);
}

// Operator tooling is judged from the parsed file, which a schema file passed by name to
// contextForFile lacks.
function contextFor(info: TableInfo, node: Node): string | undefined {
  const source = node.getSourceFile();
  const { fileName } = source;
  if (!isTestSource(fileName) && !isSeedSource(fileName) && isToolingSource(source)) {
    return 'Query in operator tooling (scripts, standalone entry points, deployment, migrations or commands).';
  }
  return contextForFile(info, fileName);
}

function contextForFile(info: TableInfo, filename: string, subject = 'Query'): string | undefined {
  if (isTestSource(filename)) return `${subject} in a test source.`;
  if (isSeedSource(filename)) return `${subject} in seed or demo-data setup.`;
  if (info.rows !== undefined && info.rows < smallTableRows) {
    return `${noun(info) === 'table' ? 'Table' : 'Collection'} has about ${info.rows.toLocaleString('en-US')} rows.`;
  }
}

function place(table: SchemaTable): string {
  return table.file ? `${relativeFile(table.file)}:${table.line}` : '';
}

// Raw SQL tables known only from a snapshot or by name have no declaration to link.
function relatedTo(table: SchemaTable): { related?: DeclarationLink[] } {
  return table.file ? { related: [declarationLink(table)] } : {};
}

function declarationLink(table: SchemaTable): DeclarationLink {
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

function indexFix(info: TableInfo, columns: string[], schemaSource: SchemaOrm | undefined): IndexFixText {
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

function nonLeadingIndex(table: SchemaTable, column: string): { index: SchemaIndex; position: number } | undefined {
  const names = lowerNames(table, column);
  for (const index of table.indexes) {
    if (index.method !== 'btree' || index.predicate) continue;
    const position = index.keys.findIndex((key) => key.column !== undefined && names.has(key.column.toLowerCase()));
    if (position > 0) return { index, position };
  }
}

function indexLabel(index: IndexSummary): string {
  return index.name ? `\`${index.name}\`` : `the index on (${index.keys.map((key) => `\`${key.column}\``).join(', ')})`;
}

function filterObservation(info: TableInfo, columns: string[]): string {
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

function labelList(columns: readonly string[]): string {
  const labels = columns.map((column) => `\`${column}\``);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

// A declared foreign key, or a column named like one (`storeId`, `school_id`) when the model
// declares none.
function isParentReference(table: SchemaTable, column: string): boolean {
  if (table.columns.get(column)?.foreignKey) return true;
  return [column, table.columns.get(column)?.dbName].some((name) => name && parentReferenceName.test(name));
}

// The columns the suggested index keys on. A foreign key already narrows the rows to one parent's,
// so when the filter has one the index keys on the foreign keys alone, not also on wide or barely
// selective columns.
function indexedColumns(info: TableInfo, filtered: string[]): string[] {
  const foreignKeys = filtered.filter((column) => isParentReference(info.table, column));
  return foreignKeys.length ? foreignKeys : filtered;
}

function reportFilter(
  site: QuerySite,
  info: TableInfo,
  candidates: QueryCondition[],
  order: OrderGap | undefined,
  context: PerformanceRuleContext,
): void {
  const equality = candidates.filter((condition) => condition.kind !== 'range').map((condition) => condition.column);
  const range = candidates.find((condition) => condition.kind === 'range')?.column;
  const filtered = [...new Set([...equality, ...(range ? [range] : [])])];
  const keyed = indexedColumns(info, filtered);
  // One composite serves the filter and the sort when no range column sits between them.
  const sortColumns =
    order && order.info === info && !(range !== undefined && keyed.includes(range))
      ? order.sortColumns.filter((column) => !keyed.includes(column))
      : [];
  const fix = indexFix(info, [...keyed, ...sortColumns], site.orm);
  const sortNote = sortColumns.length ? ` Ending it with ${labelList(sortColumns)} also serves the sort.` : '';
  const message = `${filterObservation(info, filtered)}, ${scanPhrase(info)}. ${fix.text}${sortNote}${sizeCaveat(info)}`;
  const node = candidates[0].node;
  context.report(node, 'index-missing-filter', message, contextFor(info, node), {
    suggestion: fix.suggestion,
    ...relatedTo(info.table),
  });
}

// Returns true when a finding was reported.
function infoOf(infos: ReadonlyMap<SchemaTable, TableInfo>, table: SchemaTable): TableInfo {
  const info = infos.get(table);
  if (!info) throw new Error('No table information for ' + table.name);
  return info;
}

function evaluateFilter(
  site: QuerySite,
  infos: ReadonlyMap<SchemaTable, TableInfo>,
  order: OrderGap | undefined,
  context: PerformanceRuleContext,
): boolean {
  if (!site.conditions.length) return false;
  // The planner narrows by any indexed conjunct first, so the others are filtered on few rows.
  if (site.conditions.some((condition) => isCovering(infoOf(infos, condition.table), condition))) return false;
  let reported = false;
  for (const [table, info] of infos) {
    const candidates = site.conditions.filter((condition) => condition.table === table && isCandidate(info, condition));
    if (!candidates.length) continue;
    reportFilter(site, info, candidates, order, context);
    reported = true;
  }
  return reported;
}

function namesOf(table: SchemaTable, columns: readonly string[]): Set<string> {
  return new Set(columns.flatMap((column) => [...lowerNames(table, column)]));
}

// Btree indexes from the model or snapshot plus those migrations create, as lower-case key names.
// Partial ones are included because the query might imply their predicate, which is not checked.
function orderableIndexes(info: TableInfo): OrderableIndex[] {
  const declared = info.table.indexes.flatMap((index): OrderableIndex[] => {
    const keys = index.keys.map((key) => key.column?.toLowerCase());
    return index.method === 'btree' && allDefined(keys) ? [{ index, keys }] : [];
  });
  // Migration indexes read as plain btree are never partial; the others carry their own `partial`
  // flag.
  const migratedPlain = (info.migration?.indexes ?? []).flatMap((index): OrderableIndex[] => {
    const keys = index.keys.map((key) => key.column);
    return allDefined(keys) ? [{ index: { ...index, predicate: undefined }, keys }] : [];
  });
  const migratedOthers = (info.migration?.others ?? []).flatMap((index): OrderableIndex[] => {
    const keys = index.keys.map((key) => key.column);
    return index.method.toLowerCase() === 'btree' && allDefined(keys)
      ? [{ index: { ...index, predicate: index.partial }, keys }]
      : [];
  });
  return [...declared, ...migratedPlain, ...migratedOthers];
}

// A migration expression index over a sort column might serve it in a way the rules cannot read.
function expressionMentions(info: TableInfo, columns: string[]): boolean {
  const names = namesOf(info.table, columns);
  return (info.migration?.others ?? []).some((index) =>
    index.keys.some((key) => key.columns?.some((column) => names.has(column))),
  );
}

// An index serves the sort when the first sort column follows a run of equality-filtered columns.
// Later sort columns such as an `id` tiebreaker are cheap: PostgreSQL 13+ sorts only the ties
// (incremental sort).
function servesOrder(
  keys: readonly string[],
  equality: ReadonlySet<string>,
  sortNames: readonly Set<string>[],
): boolean {
  for (let start = 0; start < keys.length; start++) {
    if (start > 0 && !equality.has(keys[start - 1])) return false;
    if (sortNames[0].has(keys[start])) return true;
  }
  return false;
}

// The existing index on exactly the equality columns, which an extended index would make redundant.
function redundantIndex(
  info: TableInfo,
  indexes: OrderableIndex[],
  equalityColumns: string[],
): IndexSummary | undefined {
  if (!equalityColumns.length) return;
  const prefix = namesOf(info.table, equalityColumns);
  return indexes.find(
    ({ index, keys }) =>
      !index.unique &&
      !index.primary &&
      !index.predicate &&
      keys.length === equalityColumns.length &&
      keys.every((key) => prefix.has(key)),
  )?.index;
}

// What a limited, sorted single-table read is missing, or undefined when an index (or doubt) covers
// it.
function orderGap(site: QuerySite, infos: ReadonlyMap<SchemaTable, TableInfo>): OrderGap | undefined {
  if (site.joins || !site.limited || !Array.isArray(site.order) || !site.order.length) return;
  const { table } = site.order[0];
  const tables = [...site.order, ...site.conditions].map((entry) => entry.table);
  if (tables.some((other) => other !== table)) return;
  const info = infoOf(infos, table);
  if (info.migration?.opaque) return;
  // An indexed `IN` list, such as `id: In(ids)`, reads only the listed rows, so the sort covers few
  // of them.
  const indexedList = (condition: QueryCondition) => condition.kind === 'in' && isCovering(info, condition);
  if (site.conditions.some(indexedList)) return;
  const equalityColumns = [
    ...new Set(
      site.conditions
        .filter((condition) => condition.kind === 'eq' || condition.kind === 'null')
        .map((condition) => condition.column),
    ),
  ];
  const sortColumns = [...new Set(site.order.map((entry) => entry.column))].filter(
    (column) => !equalityColumns.includes(column),
  );
  if (!sortColumns.length || equalityColumns.length > maxSortedEqualityColumns) return;
  const columns = [...equalityColumns, ...sortColumns];
  if (expressionMentions(info, sortColumns)) return;
  const equality = namesOf(info.table, equalityColumns);
  const indexes = orderableIndexes(info);
  // A unique key fully matched by equality returns at most one row, so there is nothing to sort; a
  // partial one might too, so it also silences.
  const fullyMatched = ({ index, keys }: OrderableIndex) =>
    (index.unique || index.primary) && keys.every((key) => equality.has(key));
  if (indexes.some(fullyMatched)) return;
  const sortNames = sortColumns.map((column) => lowerNames(info.table, column));
  if (indexes.some(({ keys }) => servesOrder(keys, equality, sortNames))) return;
  const replaced = redundantIndex(info, indexes, equalityColumns);
  const narrowedBy = indexNarrowing(info, indexes, equality, equalityColumns);
  return { info, equalityColumns, sortColumns, columns, node: site.order[0].node, replaced, narrowedBy };
}

// An equality column inside the leading keys an index shares with the filter. That index already
// narrows the read, so the sort covers only the rows it leaves (one parent's, one status's). (A
// fully matched unique key silences the rule earlier.) A parent reference is preferred because its
// note is the more specific.
function indexNarrowing(
  info: TableInfo,
  indexes: OrderableIndex[],
  equality: ReadonlySet<string>,
  equalityColumns: string[],
): string | undefined {
  const narrows = (column: string) => {
    const names = lowerNames(info.table, column);
    return indexes.some(({ index, keys }) => {
      if (index.predicate) return false;
      const prefixLength = keys.findIndex((key) => !equality.has(key));
      const prefix = prefixLength < 0 ? keys : keys.slice(0, prefixLength);
      return prefix.some((key) => names.has(key));
    });
  };
  const narrowing = equalityColumns.filter(narrows);
  return narrowing.find((column) => isParentReference(info.table, column)) ?? narrowing[0];
}

function sortedRows(info: TableInfo): string {
  if (info.rows === undefined) return '';
  const unit = info.dialect === 'mongo' ? 'documents' : 'rows';
  const source = info.capturedOn ? `, estimated from the snapshot of ${info.capturedOn}` : '';
  return ` (the ${noun(info)} has about ${info.rows.toLocaleString('en-US')} ${unit}${source})`;
}

function orderObservation(gap: OrderGap): string {
  const { info, equalityColumns, sortColumns, columns } = gap;
  const sorted = sortColumns.map((column) => `\`${info.table.name}.${column}\``).join(', then ');
  const verb = sortColumns.length === 1 ? 'orders' : 'order';
  if (!equalityColumns.length) {
    const pronoun = sortColumns.length === 1 ? 'it' : 'them';
    return (
      `${sorted} ${verb} this limited read and no index starts with ${pronoun}, ` +
      `so the database sorts the whole ${noun(info)}${sortedRows(info)} to return the first rows`
    );
  }
  return (
    `${sorted} ${verb} this limited read after filtering on ${labelList(equalityColumns)}, and no index has ` +
    `(${columns.map((column) => `\`${column}\``).join(', ')}) as leading columns, ` +
    `so the database sorts every matching row${sortedRows(info)} to return the first ones`
  );
}

function narrowedNote(info: TableInfo, column: string): string {
  if (isParentReference(info.table, column)) {
    return (
      `An index on the parent reference \`${column}\` already narrows this read to one parent's rows; ` +
      'the sort matters only if a parent can have many.'
    );
  }
  return `An index on \`${column}\` already narrows this read; the sort matters only if many rows match it.`;
}

function reportOrder(site: QuerySite, gap: OrderGap, context: PerformanceRuleContext): void {
  const { info, columns, node, replaced } = gap;
  const fix = indexFix(info, columns, site.orm);
  const cleanup = replaced ? ` Then drop ${indexLabel(replaced)}, which the new index makes redundant.` : '';
  const message = `${orderObservation(gap)}. ${fix.text}${cleanup}${sizeCaveat(info)}`;
  const narrowed = gap.narrowedBy && narrowedNote(info, gap.narrowedBy);
  context.report(node, 'index-missing-order', message, contextFor(info, node) ?? narrowed, {
    suggestion: fix.suggestion,
    ...relatedTo(info.table),
  });
}

function hasPatternIndex(info: TableInfo, column: string): boolean {
  if (patternIndex(info.table, column)) return true;
  const names = lowerNames(info.table, column);
  return [...names].some((name) => info.migration?.patternColumns.has(name));
}

// The same statement shape as fixFor's DDL, renamed and switched to the given method and key.
function variantSql(
  info: TableInfo,
  column: string,
  suffix: string | undefined,
  method: string | undefined,
  key: (list: string) => string,
): string {
  const { sql } = fixFor(info.table, [column], 'sql');
  return sql.replace(/_idx" ON /, `_${suffix}_idx" ON `).replace(/ \(([^()]*)\);$/, (_match: string, list: string) => {
    return `${method ? ` USING ${method}` : ''} (${key(list)});`;
  });
}

function indexNameIn(sql: string): string | undefined {
  return /INDEX CONCURRENTLY "([^"]+)"/.exec(sql)?.[1];
}

function trigramFix(info: TableInfo, column: string, orm: SchemaOrm | undefined): IndexFixText {
  const { table } = info;
  const sql = variantSql(info, column, 'trgm', 'gin', (list) => `${list} gin_trgm_ops`);
  const name = indexNameIn(sql);
  const where = place(table);
  const snippets: Partial<Record<SchemaOrm, [string, string]>> = {
    prisma: [
      `@@index([${column}(ops: raw("gin_trgm_ops"))], type: Gin, map: "${name}")`,
      `to model \`${table.name}\` (${where})`,
    ],
    drizzle: [
      `index('${name}').using('gin', table.${column}.op('gin_trgm_ops'))`,
      `to the indexes of table \`${table.name}\` (${where})`,
    ],
    sequelize: [
      `{ name: '${name}', fields: [{ name: '${column}', operator: 'gin_trgm_ops' }], using: 'gin' }`,
      `to the \`indexes\` of model \`${table.name}\` (${where})`,
    ],
  };
  const snippet = orm === undefined ? undefined : snippets[orm];
  // TypeORM decorators cannot name an operator class, so the index belongs in a migration.
  if (!snippet) return { suggestion: sql, text: `Add a trigram index in a migration: \`${sql}\`` };
  return {
    suggestion: snippet[0],
    text: `Add a trigram index: \`${snippet[0]}\` ${snippet[1]}; on a live database build it with \`${sql}\``,
  };
}

const prismaPatterns: Record<string, string> = {
  contains: "'%...%'",
  endsWith: "'%...'",
  startsWith: "'...%'",
};

function patternSubject(condition: QueryCondition, orm: SchemaOrm | undefined): string {
  const { operator, insensitive } = condition;
  if (orm === 'prisma' && operator !== undefined && Object.hasOwn(prismaPatterns, operator)) {
    const mode = insensitive ? " with `mode: 'insensitive'`" : '';
    return `\`${operator}\`${mode} compiles to \`${insensitive ? 'ILIKE' : 'LIKE'} ${prismaPatterns[operator]}\``;
  }
  return `\`${operator}\` with a leading \`%\``;
}

function reportPattern(
  site: QuerySite,
  info: TableInfo,
  condition: QueryCondition,
  context: PerformanceRuleContext,
): void {
  const { table } = info;
  const label = `\`${table.name}.${condition.column}\``;
  let message: string;
  let suggestion: string | undefined;
  if (info.dialect === 'mongo') {
    message =
      `This regular expression on ${label} is unanchored or case-insensitive, so an index cannot narrow it and ` +
      'MongoDB examines every document (or every key of an index on the field). Anchor it with `^` and keep it ' +
      'case-sensitive, or match a lower-cased copy of the field that is indexed.' +
      sizeCaveat(info);
  } else {
    const fix = trigramFix(info, condition.column, site.orm);
    suggestion = fix.suggestion;
    const alternative =
      site.orm === 'prisma' && !condition.insensitive && condition.operator === 'contains'
        ? ', or use `startsWith`'
        : '';
    // Without a model the rules cannot see the table's indexes, so the claim is conditional.
    const consequence = table.modelless ? ', so this scans the table unless a trigram index exists' : '';
    message =
      `${patternSubject(condition, site.orm)}, which a btree index on ${label} cannot serve${consequence}. ` +
      `${fix.text} (requires \`pg_trgm\`)${alternative}.${sizeCaveat(info)}`;
  }
  context.report(condition.node, 'index-unusable-pattern', message, contextFor(info, condition.node), {
    ...(suggestion && { suggestion }),
    ...relatedTo(table),
  });
}

// `lower(email)` or `created_at::date` -> the index key, the SQL key list and the drizzle sql``
// template.
function expressionParts(
  info: TableInfo,
  column: string,
  expression: string,
): { suffix: string | undefined; sqlKey: (list: string) => string; template: string } {
  const dbName = info.table.columns.get(column)?.dbName ?? column;
  const cast = /::(\w+)$/.exec(expression);
  const fn = /^(\w+)\(/.exec(expression)?.[1];
  const sqlKey = (list: string) => (cast ? `(${list}::${cast[1]})` : expression.replace(dbName, list));
  const template = expression.replace(dbName, '${table.' + column + '}');
  return { suffix: cast ? cast[1] : fn, sqlKey, template };
}

function expressionFix(
  info: TableInfo,
  column: string,
  expression: string,
  orm: SchemaOrm | undefined,
): { suggestion?: string; text: string } {
  const { table } = info;
  const parts = expressionParts(info, column, expression);
  const sql = variantSql(info, column, parts.suffix, undefined, parts.sqlKey);
  if (orm !== 'drizzle') return { text: `Create \`${sql}\`` };
  const name = indexNameIn(sql);
  const suggestion = `index('${name}').on(sql\`${parts.template}\`)`;
  return {
    suggestion,
    text:
      `Add \`${suggestion}\` to the indexes of table \`${table.name}\` (${place(table)}); ` +
      `on a live database build it with \`${sql}\``,
  };
}

function hasExpressionIndex(info: TableInfo, condition: IndexProbe): boolean {
  if (migrationMentions(info, condition.column)) return true;
  const names = lowerNames(info.table, condition.column);
  if ([...names].some((name) => info.migration?.expressionColumns.has(name))) return true;
  if (!condition.expression) return false;
  return expressionIndex(info.table, condition.expression) || expressionIndex(info.table, `(${condition.expression})`);
}

function reportExpression(
  site: QuerySite,
  info: TableInfo,
  condition: QueryCondition,
  context: PerformanceRuleContext,
): void {
  const { table } = info;
  const label = `\`${table.name}.${condition.column}\``;
  let message: string;
  let suggestion: string | undefined;
  if (condition.operator === 'insensitive') {
    if (hasPatternIndex(info, condition.column)) return;
    const fix = trigramFix(info, condition.column, site.orm);
    suggestion = fix.suggestion;
    message =
      `\`mode: 'insensitive'\` compiles to \`ILIKE\`, which a btree index on ${label} cannot serve. ${fix.text} ` +
      '(requires `pg_trgm`), or store the value lower-cased and match it with `equals`.';
  } else {
    const { expression } = condition;
    if (!expression || hasExpressionIndex(info, condition)) return;
    const fix = expressionFix(info, condition.column, expression, site.orm);
    suggestion = fix.suggestion;
    const effect =
      coverage(table, condition.column) === 'leading'
        ? `hides the index on ${label}`
        : `keeps PostgreSQL from using a plain index on ${label}`;
    const consequence = table.modelless ? ', so this scans the table unless an expression index exists' : '';
    message = `\`${condition.expression}\` ${effect}${consequence}. ${fix.text}, or store a normalized column.`;
  }
  context.report(
    condition.node,
    'index-unusable-expression',
    message + sizeCaveat(info),
    contextFor(info, condition.node),
    {
      ...(suggestion && { suggestion }),
      ...relatedTo(table),
    },
  );
}

// Pattern and expression conjuncts, reported only when no other conjunct lets an index narrow the
// rows first.
function evaluateUnusable(
  site: QuerySite,
  infos: ReadonlyMap<SchemaTable, TableInfo>,
  context: PerformanceRuleContext,
): void {
  if (site.conditions.some((condition) => isCovering(infoOf(infos, condition.table), condition))) return;
  for (const condition of site.conditions) {
    const info = infoOf(infos, condition.table);
    if (condition.kind === 'expression' && info.dialect === 'postgres')
      reportExpression(site, info, condition, context);
    if (condition.kind !== 'pattern' || hasPatternIndex(info, condition.column)) continue;
    if (info.dialect === 'postgres' || info.dialect === 'mongo') reportPattern(site, info, condition, context);
  }
}

function evaluateSite(site: QuerySite, context: PerformanceRuleContext): void {
  if (site.uncertain) return;
  const tables = [...site.conditions, ...(Array.isArray(site.order) ? site.order : [])].map((entry) => entry.table);
  if (!tables.length) return;
  const infos = new Map([...new Set(tables)].map((table): [SchemaTable, TableInfo] => [table, describe(table)]));
  if ([...infos.values()].some((info) => info.table.complete === false)) return;
  // A raw SQL table without a model: only a lone pattern or expression conjunct is certain to scan.
  if ([...infos.values()].some((info) => info.table.modelless)) {
    if (site.conditions.length === 1) evaluateUnusable(site, infos, context);
    return;
  }
  const order = orderGap(site, infos);
  // An index for the filter narrows the rows first, after which the sort and patterns are cheap.
  if (evaluateFilter(site, infos, order, context)) return;
  if (order) reportOrder(site, order, context);
  evaluateUnusable(site, infos, context);
}

// PostgreSQL does not index the referencing side of a foreign key, unlike MySQL's InnoDB.
function foreignKeyFinding(
  table: SchemaTable,
  columnName: string,
  orm: SchemaOrm | undefined,
): ForeignKeyFinding | undefined {
  const column = table.columns.get(columnName);
  const target = column?.foreignKey?.table;
  if (!target || (column.foreignKey?.position ?? 0) > 0 || table.complete === false) return;
  const info = describe(table);
  if (info.dialect !== 'postgres' || isCovering(info, { column: columnName, kind: 'eq' })) return;
  const label = `\`${table.name}.${columnName}\``;
  const partial = nonLeadingIndex(table, columnName);
  const observation = partial
    ? `${label} references \`${target}\` but is only the ${ordinal(partial.position + 1)} column of ${indexLabel(partial.index)}`
    : `${label} references \`${target}\` and no index starts with it`;
  const consequence =
    `so deleting or updating a \`${target}\` row scans \`${table.dbName}\` to check the reference, ` +
    `and joins from \`${target}\` cannot use an index`;
  const fix = indexFix(info, [columnName], orm);
  const caveat = ' PostgreSQL does not create this index for a foreign key automatically.';
  const file = column.file ?? table.file;
  return {
    message: `${observation}, ${consequence}. ${fix.text}${caveat}${sizeCaveat(info)}`,
    suggestion: fix.suggestion,
    contextualReason: file === undefined ? undefined : contextForFile(info, file, 'Schema'),
  };
}

function reportForeignKey(context: PerformanceRuleContext, node: Node, table: SchemaTable, columnName: string): void {
  const finding = foreignKeyFinding(table, columnName, table.orm);
  if (!finding) return;
  context.report(node, 'index-missing-foreign-key', finding.message, finding.contextualReason, {
    suggestion: finding.suggestion,
  });
}

const drizzleTableBuilders = new Set(['pgTable', 'table']);

// `pgTable('orders', { customerId: uuid().references(() => users.id) })`: one finding per
// referencing column.
function checkDrizzleForeignKeys(call: CallExpression, context: PerformanceRuleContext): void {
  const builder = calleeName(call);
  if (builder === undefined || !drizzleTableBuilders.has(builder)) return;
  const table = drizzleTableFromCall(call, context.checker);
  const columns = call.arguments[1] && ts.skipOuterExpressions(call.arguments[1]);
  if (!table || !columns || !ts.isObjectLiteralExpression(columns)) return;
  for (const property of columns.properties) {
    const name = propertyName(property);
    if (name && property.name && table.columns.get(name)?.foreignKey) {
      reportForeignKey(context, property.name, table, name);
    }
  }
}

// `@ManyToOne(() => School) @JoinColumn({ name: 'school_id' })` or sequelize-typescript
// `@ForeignKey(() => Store)`.
function checkDecoratorForeignKey(call: CallExpression, context: PerformanceRuleContext): void {
  const decorator = call.parent;
  const property = decorator.parent;
  if (!ts.isPropertyDeclaration(property) || !ts.isIdentifier(property.name) || !ts.isIdentifier(call.expression)) {
    return;
  }
  const name = property.name.text;
  const { checker } = context;
  if (call.expression.text === 'ManyToOne' && declaredInPackage(call.expression, checker, ['typeorm'])) {
    const table = typeormTable(property.parent, checker);
    const column = [...(table?.columns.values() ?? [])].find(
      (candidate) => candidate.foreignKey?.property === name && candidate.foreignKey.explicitName,
    );
    if (table && column) reportForeignKey(context, property.name, table, column.name);
  } else if (
    call.expression.text === 'ForeignKey' &&
    declaredInPackage(call.expression, checker, ['sequelize-typescript']) &&
    property.parent.name
  ) {
    const table = sequelizeTableOf(property.parent.name, checker);
    if (table?.columns.get(name)?.foreignKey) reportForeignKey(context, property.name, table, name);
  }
}

function checkIndexUsage(node: Node, context: PerformanceRuleContext): void {
  if (!ts.isCallExpression(node)) return;
  checkRedundantIndexes(node, context);
  if (ts.isDecorator(node.parent)) {
    checkDecoratorForeignKey(node, context);
    return;
  }
  checkDrizzleForeignKeys(node, context);
  // A query only tests run needs no production index, and the suggested one may undo a deliberate
  // drop.
  if (isTestSource(node.getSourceFile().fileName)) return;
  const site = querySite(node, context.checker) ?? rawSqlSite(node, context.checker);
  if (site) evaluateSite(site, context);
}

export { checkIndexUsage, foreignKeyFinding, declarationLink };
