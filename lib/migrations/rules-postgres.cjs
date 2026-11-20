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

// Functions whose value is fixed for the statement, so PostgreSQL 11+ stores the default without a rewrite.
const NON_VOLATILE_FUNCTIONS = new Set([
  'now',
  'transaction_timestamp',
  'statement_timestamp',
  'current_setting',
  'to_timestamp',
  'to_date',
  'to_char',
  'make_date',
  'make_time',
  'make_timestamp',
  'make_timestamptz',
  'make_interval',
  'date_trunc',
  'timezone',
  'lower',
  'upper',
  'btrim',
  'ltrim',
  'rtrim',
  'trim',
  'concat',
  'concat_ws',
  'length',
  'abs',
  'round',
  'floor',
  'ceil',
  'replace',
  'substring',
  'substr',
  'format',
  'md5',
  'encode',
  'decode',
  'jsonb_build_object',
  'json_build_object',
  'jsonb_build_array',
  'json_build_array',
  'to_jsonb',
  'to_json',
  'array_fill',
  'int4range',
  'int8range',
  'numrange',
  'tsrange',
  'tstzrange',
  'daterange',
]);

const NULLABLE_FIX = {
  typeorm: 'Add it with `isNullable: true` (or a constant `default`)',
  sequelize: 'Add it with `allowNull: true` (or a constant `defaultValue`)',
  knex: 'Add it with `.nullable()` (or a constant `.defaultTo(...)`)',
  sql: 'Add it nullable (or with a constant `DEFAULT`, which is instant on PostgreSQL 11+)',
};

const TYPE_NAMES = {
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  bool: 'boolean',
  bpchar: 'char',
  varbit: 'bit varying',
};

// Target types where some source types change without a rewrite (longer varchar, wider numeric).
const WIDENING_TYPES = new Set(['varchar', 'text', 'numeric', 'varbit']);

function builderFix(table, framework, operation) {
  return operation.builder ? (table[framework] ?? table.sql) : table.sql;
}

function functionName(node) {
  return (node.funcname ?? [])
    .map((part) => part.String?.sval)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase();
}

// 'dynamic' when a template hole is involved, the first volatile function name, or null.
function volatileFunction(expression) {
  if (containsPlaceholder(JSON.stringify(expression))) return 'dynamic';
  let found = null;
  const visit = (value) => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (value.FuncCall) {
      const name = functionName(value.FuncCall);
      if (!NON_VOLATILE_FUNCTIONS.has(name)) {
        found = name ?? 'unknown';
        return;
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(expression);
  return found;
}

function notNullWithoutDefault(operation, unit) {
  if (operation.kind !== 'add-column' || !operation.notNull || operation.hasDefault) return null;
  if (operation.identity || operation.serial || operation.generatedStored || !isExistingTable(operation)) return null;
  const column = display(operation.columnName);
  const fix = builderFix(NULLABLE_FIX, unit.framework, operation);
  return createFinding(operation, 'migration-not-null-without-default', {
    message: `\`ADD COLUMN ${column} ... NOT NULL\` has no default, so it fails on \`${display(operation.table)}\` once the table has rows, and app versions still running that insert without \`${operation.columnName}\` fail too. ${fix}, backfill in batches, then enforce (see \`migration-set-not-null-scan\`). An empty table accepts it, but production tables rarely stay empty.`,
    suggestion: `${fix}, backfill in batches, then enforce.`,
    example: {
      before: displaySql(operation.sql),
      after: `ADD COLUMN ${column} ... NULL; backfill in batches; then CHECK (${column} IS NOT NULL) NOT VALID, VALIDATE, SET NOT NULL`,
    },
  });
}

function volatileDefaultReason(operation) {
  if (operation.serial)
    return { reason: `\`${operation.type?.name ?? 'serial'}\` adds a \`nextval()\` default`, call: 'nextval(...)' };
  if (operation.identity)
    return { reason: '`GENERATED ... AS IDENTITY` fills every existing row', call: 'an identity' };
  if (operation.generatedStored)
    return { reason: 'A stored generated column is computed for every existing row', call: null };
  if (!operation.hasDefault || !operation.defaultExpression) return null;
  const name = volatileFunction(operation.defaultExpression);
  if (!name || name === 'dynamic') return null;
  return { reason: `\`DEFAULT ${name}()\` is volatile`, call: `${name}()` };
}

function volatileDefault(operation) {
  if (operation.kind !== 'add-column' || !isExistingTable(operation)) return null;
  const volatile = volatileDefaultReason(operation);
  if (!volatile) return null;
  const table = display(operation.table);
  const column = display(operation.columnName);
  const setDefault = volatile.call
    ? `then \`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${volatile.call};\` so only new rows get it, and backfill existing rows in batches`
    : 'then backfill it in batches';
  return createFinding(operation, 'migration-volatile-default', {
    message: `${volatile.reason}, so \`ADD COLUMN ${column}\` rewrites the whole \`${table}\` table under an ACCESS EXCLUSIVE lock, blocking reads and writes until it finishes. Add the column without a default, ${setDefault}. A constant or \`now()\` default would be instant.`,
    suggestion: `Add the column without a default, ${setDefault}.`,
    example: {
      before: displaySql(operation.sql),
      after: `ADD COLUMN ${column} <type>;${volatile.call ? ` ALTER COLUMN ${column} SET DEFAULT ${volatile.call};` : ''} backfill in batches`,
    },
  });
}

function typeText(type) {
  if (!type) return 'a new type';
  const name = TYPE_NAMES[type.name] ?? type.name;
  const modifiers = type.modifiers.filter((modifier) => modifier !== null);
  return name + (modifiers.length > 0 ? `(${modifiers.join(',')})` : '') + (type.array ? '[]' : '');
}

function sameModifiers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSafeTypeChange(previous, next) {
  if (previous.array !== next.array) return false;
  if (previous.name === next.name && sameModifiers(previous.modifiers, next.modifiers)) return true;
  const textual = new Set(['varchar', 'text']);
  if (next.name === 'text') return textual.has(previous.name);
  if (next.name === 'varchar' && textual.has(previous.name)) {
    if (next.modifiers.length === 0) return true;
    return previous.name === 'varchar' && previous.modifiers.length > 0 && next.modifiers[0] >= previous.modifiers[0];
  }
  if (next.name === previous.name && ['numeric', 'varbit'].includes(next.name)) {
    if (next.modifiers.length === 0) return true;
    if (previous.modifiers.length === 0) return false;
    const sameScale = (next.modifiers[1] ?? 0) === (previous.modifiers[1] ?? 0);
    return sameScale && next.modifiers[0] >= previous.modifiers[0];
  }
  return false;
}

function columnTypeRewrite(operation, unit, registry) {
  if (operation.kind !== 'alter-column-type' || !isExistingTable(operation)) return null;
  if (containsPlaceholder(operation.columnName) || containsPlaceholder(JSON.stringify(operation.type ?? null)))
    return null;
  const previous = registry.columnTypes.get(operation.table)?.get(operation.columnName) ?? null;
  const next = operation.type;
  if (previous && next && !operation.hasUsing && isSafeTypeChange(previous, next)) return null;
  const table = display(operation.table);
  const column = display(operation.columnName);
  const change = previous && next ? ` from \`${typeText(previous)}\` to \`${typeText(next)}\`` : '';
  const label = operation.builder
    ? `\`${displaySql(operation.sql)}\``
    : `\`ALTER COLUMN ${column} TYPE ${typeText(next)}\`${change}`;
  const fix = 'Add a new column, dual-write, backfill in batches, switch reads, then drop the old column';
  const caveat =
    !previous && next && WIDENING_TYPES.has(next.name) && !operation.hasUsing
      ? ` If \`${operation.columnName}\` is currently a shorter \`varchar\` or a narrower \`numeric\`, this is metadata-only and safe; mark it reviewed.`
      : operation.builder
        ? ' If only nullability or the default changes, use `ALTER COLUMN ... SET/DROP NOT NULL` or `SET DEFAULT` instead, which do not rewrite.'
        : '';
  return createFinding(operation, 'migration-column-type-rewrite', {
    message: `${label} rewrites \`${table}\` and rebuilds its indexes under an ACCESS EXCLUSIVE lock, blocking reads and writes until it finishes. ${fix}.${caveat}`,
    suggestion: fix + '.',
    example: {
      before: displaySql(operation.sql),
      after: `ADD COLUMN ${display((operation.columnName ?? 'column') + '_new')} ${typeText(next)}; dual-write; backfill in batches; swap`,
    },
  });
}

function hasValidatedNotNullCheck(registry, table, column) {
  const checks = registry.notNullChecks.get(table);
  return [...(checks?.values() ?? [])].some((check) => check.column === column && check.validated);
}

function setNotNullScan(operation, unit, registry) {
  if (operation.kind !== 'set-not-null' || !isExistingTable(operation)) return null;
  if (containsPlaceholder(operation.columnName)) return null;
  if (hasValidatedNotNullCheck(registry, operation.table, operation.columnName)) return null;
  const table = display(operation.table);
  const column = display(operation.columnName);
  const constraint = display(`${operation.table}_${operation.columnName}_not_null`);
  const steps = `\`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} IS NOT NULL) NOT VALID;\`, then in a later migration \`ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint};\` and \`SET NOT NULL\``;
  return createFinding(operation, 'migration-set-not-null-scan', {
    message: `\`SET NOT NULL\` on \`${table}.${column}\` scans the whole table under an ACCESS EXCLUSIVE lock to prove it has no NULLs. Instead: ${steps} (PostgreSQL 12+ then skips the scan), and finally drop the check. The column must be backfilled first either way.`,
    suggestion: `${steps}.`,
    example: {
      before: displaySql(operation.sql),
      after: `ADD CONSTRAINT ${constraint} CHECK (${column} IS NOT NULL) NOT VALID; -- later: VALIDATE CONSTRAINT ${constraint}; SET NOT NULL`,
    },
  });
}

const OPERATION_RULES = [
  indexNotConcurrent,
  concurrentInTransaction,
  tableRewriteCommand,
  notNullWithoutDefault,
  volatileDefault,
  columnTypeRewrite,
  setNotNullScan,
];

// Project-wide memory across migration files, processed in order: column types and NOT NULL checks.
function createPostgresRegistry() {
  return { columnTypes: new Map(), notNullChecks: new Map() };
}

function tableEntry(map, table) {
  if (!map.has(table)) map.set(table, new Map());
  return map.get(table);
}

function moveTable(map, from, to) {
  if (!map.has(from)) return;
  map.set(to, map.get(from));
  map.delete(from);
}

function recordOperation(registry, operation) {
  const { table, columnName } = operation;
  if (!table) return;
  switch (operation.kind) {
    case 'create-table':
      for (const column of operation.columns ?? [])
        tableEntry(registry.columnTypes, table).set(column.name, column.type);
      break;
    case 'add-column':
    case 'alter-column-type':
      if (operation.type) tableEntry(registry.columnTypes, table).set(columnName, operation.type);
      break;
    case 'drop-column':
      registry.columnTypes.get(table)?.delete(columnName);
      break;
    case 'rename-column': {
      const columns = registry.columnTypes.get(table);
      if (columns?.has(columnName)) columns.set(operation.newName, columns.get(columnName));
      columns?.delete(columnName);
      break;
    }
    case 'rename-table':
      moveTable(registry.columnTypes, table, operation.newName);
      moveTable(registry.notNullChecks, table, operation.newName);
      break;
    case 'drop-table':
      registry.columnTypes.delete(table);
      registry.notNullChecks.delete(table);
      break;
    case 'add-constraint':
      if (operation.checkNotNullColumn) {
        tableEntry(registry.notNullChecks, table).set(operation.constraintName ?? operation.checkNotNullColumn, {
          column: operation.checkNotNullColumn,
          validated: !operation.notValid,
        });
      }
      break;
    case 'validate-constraint': {
      const check = registry.notNullChecks.get(table)?.get(operation.constraintName);
      if (check) check.validated = true;
      break;
    }
    default:
      break;
  }
}

// unit: { file, framework, operations } with operations already annotated by annotateUnit.
function checkPostgresUnit(unit, registry = createPostgresRegistry()) {
  const findings = [];
  for (const operation of unit.operations) {
    for (const rule of OPERATION_RULES) {
      const finding = rule(operation, unit, registry);
      if (finding) findings.push(finding);
    }
    recordOperation(registry, operation);
  }
  const lockTimeout = missingLockTimeout(unit.operations, unit);
  if (lockTimeout) findings.push(lockTimeout);
  return findings.sort((left, right) => left.line - right.line || left.column - right.column);
}

module.exports = { checkPostgresUnit, createPostgresRegistry, display, displaySql, isExistingTable };
