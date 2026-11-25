import type {
  ColumnForeignKey,
  SchemaColumn,
  SchemaIndex,
  SchemaIndexKey,
  SchemaOrm,
  SchemaTable,
} from '../types/schema-model.js';

export interface TableInit {
  name: string;
  dbName?: string;
  dialect?: string;
  file?: string;
  line?: number;
  column?: number;
  rowEstimate?: number;
}

export interface ColumnInit {
  name: string;
  dbName?: string;
  type?: string;
  file?: string;
  line?: number;
  column?: number;
  foreignKey?: ColumnForeignKey;
}

export interface IndexInit {
  name?: string;
  keys: SchemaIndexKey[];
  unique?: boolean;
  primary?: boolean;
  method?: string;
  predicate?: string;
  file?: string;
  line?: number;
}

/** True when no entry is undefined; narrows a list of optional reads to a list of values. */
function allDefined<Item>(items: (Item | undefined)[]): items is Item[] {
  return items.every((item) => item !== undefined);
}

export type IndexCoverage = 'leading' | 'non-leading' | 'none';

interface Suggestion {
  name: string;
  sql: string;
}

export interface IndexFix {
  suggestion: string;
  sql: string;
  name: string;
}
// PostgreSQL truncates longer identifiers, which would make two generated index names collide
// silently.
const maxIdentifierLength = 63;
const trigramOperatorClass = /_trgm_ops$/;
const prefixOperatorClasses = new Set(['text_pattern_ops', 'varchar_pattern_ops', 'bpchar_pattern_ops']);

function createTable({ name, dbName = name, dialect, file, line, column, rowEstimate }: TableInit): SchemaTable {
  const table: SchemaTable = { name, dbName, dialect, file, line, column, columns: new Map(), indexes: [] };
  if (rowEstimate !== undefined) table.rowEstimate = rowEstimate;
  return table;
}

function createColumn({ name, dbName = name, type, file, line, column, foreignKey }: ColumnInit): SchemaColumn {
  const created: SchemaColumn = { name, dbName, type, file, line, column };
  if (foreignKey) created.foreignKey = foreignKey;
  return created;
}

function createIndex({
  name,
  keys,
  unique = false,
  primary = false,
  method = 'btree',
  predicate,
  file,
  line,
}: IndexInit): SchemaIndex {
  const index: SchemaIndex = { keys, unique, primary, method };
  if (name !== undefined) index.name = name;
  if (predicate !== undefined) index.predicate = predicate;
  if (file !== undefined) index.file = file;
  if (line !== undefined) index.line = line;
  return index;
}

// Several primary-key columns form one composite key; only its first column leads an index.
function mergePrimaryKeys(table: SchemaTable): void {
  const primaries = table.indexes.filter((index) => index.primary);
  if (primaries.length < 2) return;
  table.indexes = table.indexes.filter((index) => !index.primary);
  table.indexes.push(
    createIndex({
      keys: primaries.flatMap((index) => index.keys),
      unique: true,
      primary: true,
      line: primaries[0].line,
    }),
  );
}

function namesOf(table: SchemaTable, column: string): Set<string> {
  const declared = table.columns.get(column);
  return new Set([column, declared?.dbName].filter((name): name is string => Boolean(name)));
}

// Partial indexes help only queries whose predicate implies theirs, which a column name alone
// cannot show.
function orderedIndexes(table: SchemaTable): SchemaIndex[] {
  return table.indexes.filter((index) => index.method === 'btree' && !index.predicate);
}

function coverage(table: SchemaTable, column: string): IndexCoverage {
  const names = namesOf(table, column);
  let found: IndexCoverage = 'none';
  for (const index of orderedIndexes(table)) {
    const position = index.keys.findIndex((key) => key.column !== undefined && names.has(key.column));
    if (position === 0) return 'leading';
    if (position > 0) found = 'non-leading';
  }
  return found;
}

function patternIndex(table: SchemaTable, column: string, { prefix = false }: { prefix?: boolean } = {}): boolean {
  const names = namesOf(table, column);
  return table.indexes.some((index) => {
    if (index.predicate) return false;
    if (index.method === 'gin' || index.method === 'gist') {
      return index.keys.some(
        (key) => key.column !== undefined && names.has(key.column) && trigramOperatorClass.test(key.opclass ?? ''),
      );
    }
    const [leading] = index.keys;
    return (
      prefix &&
      index.method === 'btree' &&
      leading?.column !== undefined &&
      names.has(leading.column) &&
      leading.opclass !== undefined &&
      prefixOperatorClasses.has(leading.opclass)
    );
  });
}

// Catalogs and schema files spell the same expression with different quoting, spacing and
// parentheses.
function normalizeExpression(expression: string): string {
  let normalized = expression.replaceAll(/["`\s]/g, '').toLowerCase();
  while (/^\(.*\)$/.test(normalized) && balanced(normalized.slice(1, -1))) normalized = normalized.slice(1, -1);
  return normalized;
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === '(') depth++;
    else if (character === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

function expressionIndex(table: SchemaTable, expression: string): boolean {
  const wanted = normalizeExpression(expression);
  return orderedIndexes(table).some((index) => {
    const [leading] = index.keys;
    return leading?.expression !== undefined && normalizeExpression(leading.expression) === wanted;
  });
}

function snakeCase(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function indexName(table: SchemaTable, databaseColumns: string[]): string {
  const tableName = table.dbName.split('.').at(-1) ?? '';
  return (
    [tableName, ...databaseColumns]
      .map(snakeCase)
      .join('_')
      .slice(0, maxIdentifierLength - 4) + '_idx'
  );
}

function quoteIdentifier(identifier: string, quote: string): string {
  return quote + identifier.replaceAll(quote, quote + quote) + quote;
}

function quoteTable(dbName: string, quote: string): string {
  return dbName
    .split('.')
    .map((part) => quoteIdentifier(part, quote))
    .join('.');
}

function databaseDdl(table: SchemaTable, columns: string[], databaseColumns: string[], name: string): string {
  if (table.dialect === 'mongo') {
    const keys = columns.map((column) => `${column}: 1`).join(', ');
    return `db.${table.dbName}.createIndex({ ${keys} }, { name: '${name}' })`;
  }
  const quote = table.dialect === 'mysql' ? '`' : '"';
  const columnList = databaseColumns.map((column) => quoteIdentifier(column, quote)).join(', ');
  const target = `${quoteIdentifier(name, quote)} ON ${quoteTable(table.dbName, quote)} (${columnList})`;
  // MySQL has no CONCURRENTLY; stating the algorithm makes it fail instead of silently copying the
  // table.
  if (table.dialect === 'mysql') return `CREATE INDEX ${target} ALGORITHM=INPLACE LOCK=NONE;`;
  return `CREATE INDEX CONCURRENTLY ${target};`;
}

// Every ORM suggestion names the index explicitly, so the ORM and the suggested SQL agree on one
// name and running both does not create a duplicate.
const suggestionsByOrm: Record<string, (table: SchemaTable, columns: string[], suggestion: Suggestion) => string> = {
  prisma: (table, columns, { name }) => `@@index([${columns.join(', ')}], map: "${name}")`,
  drizzle: (table, columns, { name }) =>
    `index('${name}').on(${columns.map((column) => 'table.' + column).join(', ')})`,
  typeorm: (table, columns, { name }) =>
    columns.length === 1
      ? `@Index('${name}') on the property \`${columns[0]}\``
      : `@Index('${name}', [${columns.map((column) => `'${column}'`).join(', ')}]) on the class`,
  sequelize: (table, columns, { name }) =>
    `{ name: '${name}', fields: [${columns.map((column) => `'${column}'`).join(', ')}] } in \`indexes\``,
  mongoose: (table, columns, { name }) =>
    `${lowerFirst(table.name)}Schema.index({ ${columns.map((column) => `${column}: 1`).join(', ')} }, { name: '${name}' })`,
  sql: (table, columns, { sql }) => sql,
};

function fixFor(table: SchemaTable, columns: string[], orm: SchemaOrm | string): IndexFix {
  if (!Object.hasOwn(suggestionsByOrm, orm)) throw new Error('Unknown schema source: ' + orm);
  const databaseColumns = columns.map((column) => table.columns.get(column)?.dbName ?? column);
  const name = indexName(table, databaseColumns);
  const sql = databaseDdl(table, columns, databaseColumns, name);
  return { suggestion: suggestionsByOrm[orm](table, columns, { name, sql }), sql, name };
}

export {
  allDefined,
  createTable,
  createColumn,
  createIndex,
  mergePrimaryKeys,
  coverage,
  patternIndex,
  expressionIndex,
  normalizeExpression,
  fixFor,
};
