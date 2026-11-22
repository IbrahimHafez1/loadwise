'use strict';

// One intermediate representation for every migration source (.sql, query literals, schema builders),
// so the rules never look at SQL text or framework APIs directly.

const MIGRATION_RULES = [
  'migration-index-not-concurrent',
  'migration-concurrent-in-transaction',
  'migration-not-null-without-default',
  'migration-volatile-default',
  'migration-column-type-rewrite',
  'migration-set-not-null-scan',
  'migration-constraint-not-valid',
  'migration-constraint-without-index',
  'migration-breaking-drop',
  'migration-breaking-rename',
  'migration-missing-lock-timeout',
  'migration-table-rewrite-command',
  'migration-unparsed',
  'migration-mysql-table-copy',
  'migration-mysql-lock-unspecified',
];

const FRAMEWORKS = ['prisma', 'drizzle', 'typeorm', 'knex', 'sequelize', 'mikro-orm', 'sql'];

const OPERATION_KINDS = new Set([
  'create-table',
  'create-index',
  'drop-index',
  'add-column',
  'alter-column-type',
  'set-not-null',
  'add-constraint',
  'validate-constraint',
  'drop-constraint',
  'rename-constraint',
  'drop-column',
  'drop-table',
  'rename-column',
  'rename-table',
  // ALTER TABLE forms that take a lock but are otherwise harmless (SET DEFAULT, triggers, ...).
  'alter-table-other',
  'drop-primary-key',
  'truncate',
  'convert-charset',
  'set-lock-timeout',
  'transaction-begin',
  'transaction-end',
  'table-rewrite-command',
  'unparsed',
  'data',
  'other',
]);

// Placeholder spliced into SQL where a template literal has a `${...}` hole.
const DYNAMIC_PLACEHOLDER_PREFIX = '__bpc_dynamic_';
const COMPACT_SQL_LENGTH = 160;

function createOperation(fields) {
  if (!OPERATION_KINDS.has(fields.kind)) throw new Error('Unknown migration operation kind: ' + fields.kind);
  return {
    table: null,
    columnName: null,
    concurrent: false,
    notValid: false,
    usingIndex: false,
    inTransaction: false,
    createdInSameUnit: false,
    emptiedInSameUnit: false,
    dynamic: false,
    sql: null,
    ...fields,
  };
}

function containsPlaceholder(value) {
  return typeof value === 'string' && value.includes(DYNAMIC_PLACEHOLDER_PREFIX);
}

// Postgres folds unquoted names before they reach us, MySQL names are case-insensitive on common setups.
function tableKey(name, dialect) {
  if (!name) return null;
  return dialect === 'mysql' ? name.toLowerCase() : name;
}

function quoteIdentifier(name, dialect = 'postgres') {
  if (!name) return '?';
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  return dialect === 'mysql' ? '`' + name.replaceAll('`', '``') + '`' : '"' + name.replaceAll('"', '""') + '"';
}

function compactSql(text) {
  if (!text) return '';
  const singleLine = text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '');
  return singleLine.length > COMPACT_SQL_LENGTH ? singleLine.slice(0, COMPACT_SQL_LENGTH - 3) + '...' : singleLine;
}

// Fills the per-unit context the rules rely on: transaction state and tables created or emptied earlier in the unit.
function annotateUnit(operations, { inTransaction, dialect }) {
  const createdTables = new Set();
  const emptiedTables = new Set();
  const renamedIntoTables = new Set();
  let explicitTransaction = false;
  for (const operation of operations) {
    if (operation.kind === 'transaction-begin') explicitTransaction = true;
    else if (operation.kind === 'transaction-end') explicitTransaction = false;
    operation.inTransaction = Boolean(inTransaction || explicitTransaction || operation.explicitTransaction);
    const key = tableKey(operation.table, dialect);
    if (operation.kind === 'create-table' && key) createdTables.add(key);
    if (operation.kind === 'rename-table' && createdTables.has(key) && operation.newName) {
      createdTables.add(tableKey(operation.newName, dialect));
    }
    operation.createdInSameUnit = key !== null && createdTables.has(key);
    operation.emptiedInSameUnit = key !== null && emptiedTables.has(key);
    // A name that only exists because this unit renamed a table into it is unknown to running app versions.
    operation.renamedInSameUnit = key !== null && renamedIntoTables.has(key);
    if (operation.kind === 'rename-table' && operation.newName)
      renamedIntoTables.add(tableKey(operation.newName, dialect));
    // Inside a transaction the TRUNCATE lock is held, so the table stays empty for the rest of the unit.
    if (operation.kind === 'truncate' && key && operation.inTransaction) emptiedTables.add(key);
  }
  operations.forEach((operation, position) => {
    if (operation.kind === 'rename-table') {
      operation.nameRecreatedInSameUnit = isRecreatedInSameTransaction(operations, position, dialect);
    }
  });
  return operations;
}

// Rename-and-recreate in one transaction: readers never see the old name disappear.
function isRecreatedInSameTransaction(operations, position, dialect) {
  const renamed = operations[position];
  if (!renamed.inTransaction) return false;
  const key = tableKey(renamed.table, dialect);
  for (const later of operations.slice(position + 1)) {
    if (later.kind === 'transaction-end' || !later.inTransaction) return false;
    if (later.kind === 'create-table' && tableKey(later.table, dialect) === key) return true;
  }
  return false;
}

function createFinding(operation, ruleId, { message, suggestion, example }) {
  return {
    file: operation.file,
    line: operation.line,
    column: operation.column,
    ruleId,
    message,
    suggestion,
    example,
  };
}

module.exports = {
  MIGRATION_RULES,
  FRAMEWORKS,
  OPERATION_KINDS,
  DYNAMIC_PLACEHOLDER_PREFIX,
  createOperation,
  containsPlaceholder,
  tableKey,
  quoteIdentifier,
  compactSql,
  annotateUnit,
  createFinding,
};
