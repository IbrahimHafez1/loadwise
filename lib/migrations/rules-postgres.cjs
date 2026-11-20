'use strict';

// PostgreSQL >= 12 migration rules. Each finding reads: observation, fix (snippets in backticks), caveat.

const {
  DYNAMIC_PLACEHOLDER_PREFIX,
  compactSql,
  containsPlaceholder,
  createFinding,
  quoteIdentifier,
} = require('./operations.cjs');

const PLACEHOLDER_PATTERN = new RegExp(DYNAMIC_PLACEHOLDER_PREFIX + '\\d+', 'g');
const LOCK_TIMEOUT_STATEMENT = "SET lock_timeout = '5s';";

const NON_TRANSACTIONAL_HOW = {
  prisma:
    'in a migration file containing only this statement, because Prisma runs a multi-statement file in one transaction',
  drizzle:
    'outside the Drizzle migrator (for example a separate `psql` step), because it runs every migration in one transaction',
  typeorm:
    'in its own migration class with `transaction = false`, because TypeORM wraps each migration in a transaction',
  knex: 'in its own migration with `exports.config = { transaction: false }`, because Knex wraps each migration in a transaction',
  sequelize: 'in a raw query outside any `sequelize.transaction(...)`',
  sql: 'outside any `BEGIN ... COMMIT` block',
};

const LEAVE_TRANSACTION_FIX = {
  prisma: 'Move it to a migration file containing only this statement',
  drizzle: 'Run it outside the Drizzle migrator, which wraps every migration in a transaction',
  typeorm: 'Set `transaction = false` on the migration class',
  knex: 'Add `exports.config = { transaction: false };` to this migration',
  sequelize: 'Run it outside `sequelize.transaction(...)`',
  sql: 'Move it after `COMMIT`',
};

const LOCK_TAKING_KINDS = new Set([
  'create-index',
  'drop-index',
  'add-column',
  'alter-column-type',
  'set-not-null',
  'add-constraint',
  'drop-column',
  'drop-table',
  'rename-column',
  'rename-table',
  'alter-table-other',
  'table-rewrite-command',
]);

function display(name) {
  if (!name) return '?';
  return quoteIdentifier(name).replace(PLACEHOLDER_PATTERN, '${...}');
}

function displaySql(text) {
  return compactSql(text).replace(PLACEHOLDER_PATTERN, '${...}');
}

function frameworkKey(framework) {
  return NON_TRANSACTIONAL_HOW[framework] ? framework : 'sql';
}

// Lock, rewrite and constraint rules apply only to tables that existed before this migration.
function isExistingTable(operation) {
  return Boolean(operation.table) && !operation.createdInSameUnit && !containsPlaceholder(operation.table);
}

function concurrentIndexSql(operation) {
  if (operation.builder) return null;
  return operation.sql.replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX)\s+/i, '$1 CONCURRENTLY ');
}

function indexNotConcurrent(operation, unit) {
  if (operation.kind !== 'create-index' || operation.concurrent || operation.onlyParent) return null;
  if (!isExistingTable(operation)) return null;
  const table = display(operation.table);
  const label =
    '`' + (operation.builder ? displaySql(operation.sql) : displaySql(operation.sql).split(/\s+ON\s+/i)[0]) + '`';
  const fixedSql = concurrentIndexSql(operation);
  const fix = operation.builder
    ? builderConcurrentFix(unit.framework, operation)
    : 'Use `' + displaySql(fixedSql) + '`';
  const where = operation.inTransaction
    ? NON_TRANSACTIONAL_HOW[frameworkKey(unit.framework)]
    : 'in this migration, which already runs outside a transaction';
  return createFinding(operation, 'migration-index-not-concurrent', {
    message: `${label} on existing table \`${table}\` blocks writes for the whole build. ${fix} ${where}. A failed concurrent build leaves an invalid index; drop it and retry.`,
    suggestion: `${fix} ${where}.`,
    example: { before: displaySql(operation.sql), after: fixedSql ? displaySql(fixedSql) : fix },
  });
}

function builderConcurrentFix(framework, operation) {
  const table = display(operation.table);
  if (framework === 'sequelize')
    return "Pass `{ concurrently: true }` to `queryInterface.addIndex('" + operation.table + "', ...)`";
  if (framework === 'knex') return "Use `knex.raw('CREATE INDEX CONCURRENTLY ... ON " + table + " (...)')`";
  return "Use `queryRunner.query('CREATE INDEX CONCURRENTLY ... ON " + table + " (...)')`";
}

function concurrentCommandLabel(operation) {
  if (operation.kind === 'create-index') return 'CREATE INDEX CONCURRENTLY';
  if (operation.kind === 'drop-index') return 'DROP INDEX CONCURRENTLY';
  return 'REINDEX ... CONCURRENTLY';
}

function concurrentInTransaction(operation, unit) {
  const concurrentKinds = ['create-index', 'drop-index', 'table-rewrite-command'];
  if (!concurrentKinds.includes(operation.kind) || !operation.concurrent || !operation.inTransaction) return null;
  const label = concurrentCommandLabel(operation);
  const fix = operation.explicitTransaction
    ? LEAVE_TRANSACTION_FIX.sequelize
    : LEAVE_TRANSACTION_FIX[frameworkKey(unit.framework)];
  return createFinding(operation, 'migration-concurrent-in-transaction', {
    message: `\`${label}\` cannot run inside a transaction block, so this migration fails when it runs. ${fix}. Each statement then commits on its own, so keep it idempotent (\`IF NOT EXISTS\`).`,
    suggestion: fix + '.',
    example: {
      before: displaySql(operation.sql) + ' -- inside a transaction',
      after: displaySql(operation.sql) + ' -- ' + fix.toLowerCase(),
    },
  });
}

const REWRITE_FIX = {
  'VACUUM FULL': 'Use `pg_repack` to rebuild the table online, or run it in a maintenance window',
  CLUSTER: 'Use `pg_repack --order-by` to reorder the table online, or run it in a maintenance window',
  REINDEX: 'Use `REINDEX ... CONCURRENTLY` (PostgreSQL 12+) outside a transaction',
};

function tableRewriteCommand(operation) {
  if (operation.kind !== 'table-rewrite-command' || operation.concurrent) return null;
  if (operation.table && !isExistingTable(operation)) return null;
  const fix = REWRITE_FIX[operation.command];
  const blocked = operation.command === 'REINDEX' ? 'writes (and reads that use the index)' : 'reads and writes';
  const after =
    operation.command === 'REINDEX'
      ? displaySql(operation.sql).replace(/^REINDEX\s+(\w+)/i, 'REINDEX $1 CONCURRENTLY')
      : 'pg_repack --table ' + (operation.table ?? '<table>');
  return createFinding(operation, 'migration-table-rewrite-command', {
    message: `\`${displaySql(operation.sql)}\` holds a lock that blocks ${blocked} until it finishes. ${fix}. Its run time grows with the table size.`,
    suggestion: fix + '.',
    example: { before: displaySql(operation.sql), after },
  });
}

function lockTimeoutFix(framework) {
  if (framework === 'typeorm') return `Start \`up()\` with \`await queryRunner.query("${LOCK_TIMEOUT_STATEMENT}")\``;
  if (framework === 'knex') return `Start \`up()\` with \`await knex.raw("${LOCK_TIMEOUT_STATEMENT}")\``;
  if (framework === 'sequelize')
    return `Start \`up()\` with \`await queryInterface.sequelize.query("${LOCK_TIMEOUT_STATEMENT}")\``;
  return `Start the migration with \`${LOCK_TIMEOUT_STATEMENT}\``;
}

// Once per file: the first statement that queues for a lock on an existing table with no lock_timeout set before it.
function missingLockTimeout(operations, unit) {
  for (const operation of operations) {
    if (operation.kind === 'set-lock-timeout') return null;
    if (!LOCK_TAKING_KINDS.has(operation.kind) || operation.concurrent || !isExistingTable(operation)) continue;
    const fix = lockTimeoutFix(unit.framework);
    return createFinding(operation, 'migration-missing-lock-timeout', {
      message: `\`${displaySql(operation.sql)}\` waits for a lock on \`${display(operation.table)}\` with no \`lock_timeout\`, and every later query on that table queues behind the wait. ${fix} so a blocked DDL fails fast instead of queueing every query behind it, then retry. Skip this if the migration runner already sets \`lock_timeout\` on its connection.`,
      suggestion: fix + '.',
      example: { before: displaySql(operation.sql), after: `${LOCK_TIMEOUT_STATEMENT} ${displaySql(operation.sql)}` },
    });
  }
  return null;
}

const OPERATION_RULES = [indexNotConcurrent, concurrentInTransaction, tableRewriteCommand];

function createPostgresRegistry() {
  return {};
}

// unit: { file, framework, operations } with operations already annotated by annotateUnit.
function checkPostgresUnit(unit) {
  const findings = [];
  for (const operation of unit.operations) {
    for (const rule of OPERATION_RULES) {
      const finding = rule(operation, unit);
      if (finding) findings.push(finding);
    }
  }
  const lockTimeout = missingLockTimeout(unit.operations, unit);
  if (lockTimeout) findings.push(lockTimeout);
  return findings.sort((left, right) => left.line - right.line || left.column - right.column);
}

module.exports = { checkPostgresUnit, createPostgresRegistry, display, displaySql, isExistingTable };
