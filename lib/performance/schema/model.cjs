'use strict';

// PostgreSQL truncates longer identifiers, which would make two generated index names collide silently.
const maxIdentifierLength = 63;
const trigramOperatorClass = /_trgm_ops$/;
const prefixOperatorClasses = new Set(['text_pattern_ops', 'varchar_pattern_ops', 'bpchar_pattern_ops']);

function createTable({ name, dbName = name, dialect, file, line, column, rowEstimate }) {
  const table = { name, dbName, dialect, file, line, column, columns: new Map(), indexes: [] };
  if (rowEstimate !== undefined) table.rowEstimate = rowEstimate;
  return table;
}

function createColumn({ name, dbName = name, type, file, line, column, foreignKey }) {
  const created = { name, dbName, type, file, line, column };
  if (foreignKey) created.foreignKey = foreignKey;
  return created;
}

function createIndex({ name, keys, unique = false, primary = false, method = 'btree', predicate, file, line }) {
  const index = { keys, unique, primary, method };
  for (const [field, value] of Object.entries({ name, predicate, file, line })) {
    if (value !== undefined) index[field] = value;
  }
  return index;
}

function namesOf(table, column) {
  const declared = table.columns.get(column);
  return new Set([column, declared?.dbName].filter(Boolean));
}

// Partial indexes help only queries whose predicate implies theirs, which a column name alone cannot show.
function orderedIndexes(table) {
  return table.indexes.filter((index) => index.method === 'btree' && !index.predicate);
}

function coverage(table, column) {
  const names = namesOf(table, column);
  let found = 'none';
  for (const index of orderedIndexes(table)) {
    const position = index.keys.findIndex((key) => key.column && names.has(key.column));
    if (position === 0) return 'leading';
    if (position > 0) found = 'non-leading';
  }
  return found;
}

function patternIndex(table, column, { prefix = false } = {}) {
  const names = namesOf(table, column);
  return table.indexes.some((index) => {
    if (index.predicate) return false;
    if (index.method === 'gin' || index.method === 'gist') {
      return index.keys.some((key) => names.has(key.column) && trigramOperatorClass.test(key.opclass ?? ''));
    }
    const [leading] = index.keys;
    return (
      prefix && index.method === 'btree' && names.has(leading?.column) && prefixOperatorClasses.has(leading.opclass)
    );
  });
}

// Catalogs and schema files spell the same expression with different quoting, spacing and parentheses.
function normalizeExpression(expression) {
  let normalized = expression.replace(/["`\s]/g, '').toLowerCase();
  while (/^\(.*\)$/.test(normalized) && balanced(normalized.slice(1, -1))) normalized = normalized.slice(1, -1);
  return normalized;
}

function balanced(text) {
  let depth = 0;
  for (const character of text) {
    if (character === '(') depth++;
    else if (character === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

function expressionIndex(table, expression) {
  const wanted = normalizeExpression(expression);
  return orderedIndexes(table).some((index) => {
    const [leading] = index.keys;
    return leading?.expression !== undefined && normalizeExpression(leading.expression) === wanted;
  });
}

function snakeCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

function lowerFirst(name) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function indexName(table, databaseColumns) {
  const tableName = table.dbName.split('.').at(-1);
  return (
    [tableName, ...databaseColumns]
      .map(snakeCase)
      .join('_')
      .slice(0, maxIdentifierLength - 4) + '_idx'
  );
}

function quoteIdentifier(identifier, quote) {
  return quote + identifier.replaceAll(quote, quote + quote) + quote;
}

function quoteTable(dbName, quote) {
  return dbName
    .split('.')
    .map((part) => quoteIdentifier(part, quote))
    .join('.');
}

function databaseDdl(table, columns, databaseColumns, name) {
  if (table.dialect === 'mongo') {
    const keys = columns.map((column) => `${column}: 1`).join(', ');
    return `db.${table.dbName}.createIndex({ ${keys} })`;
  }
  const quote = table.dialect === 'mysql' ? '`' : '"';
  const columnList = databaseColumns.map((column) => quoteIdentifier(column, quote)).join(', ');
  const target = `${quoteIdentifier(name, quote)} ON ${quoteTable(table.dbName, quote)} (${columnList})`;
  // MySQL has no CONCURRENTLY; stating the algorithm makes it fail instead of silently copying the table.
  if (table.dialect === 'mysql') return `CREATE INDEX ${target} ALGORITHM=INPLACE LOCK=NONE;`;
  return `CREATE INDEX CONCURRENTLY ${target};`;
}

const suggestionsByOrm = {
  prisma: (table, columns) => `@@index([${columns.join(', ')}])`,
  drizzle: (table, columns, { name }) =>
    `index('${name}').on(${columns.map((column) => 'table.' + column).join(', ')})`,
  typeorm: (table, columns) =>
    columns.length === 1
      ? `@Index() on the property \`${columns[0]}\``
      : `@Index([${columns.map((column) => `'${column}'`).join(', ')}]) on the class`,
  sequelize: (table, columns) => `{ fields: [${columns.map((column) => `'${column}'`).join(', ')}] } in \`indexes\``,
  mongoose: (table, columns) =>
    `${lowerFirst(table.name)}Schema.index({ ${columns.map((column) => `${column}: 1`).join(', ')} })`,
  sql: (table, columns, { sql }) => sql,
};

function fixFor(table, columns, orm) {
  if (!Object.hasOwn(suggestionsByOrm, orm)) throw new Error('Unknown schema source: ' + orm);
  const databaseColumns = columns.map((column) => table.columns.get(column)?.dbName ?? column);
  const name = indexName(table, databaseColumns);
  const sql = databaseDdl(table, columns, databaseColumns, name);
  return { suggestion: suggestionsByOrm[orm](table, columns, { name, sql }), sql };
}

module.exports = {
  createTable,
  createColumn,
  createIndex,
  coverage,
  patternIndex,
  expressionIndex,
  normalizeExpression,
  fixFor,
};
