// PostgreSQL >= 12 migration rules. Each finding reads: observation, fix (snippets in backticks),
// caveat.

import {
  DYNAMIC_PLACEHOLDER_PREFIX,
  compactSql,
  containsPlaceholder,
  createFinding,
  quoteIdentifier,
} from './operations.cjs';
import {
  createPostgresRegistry,
  hasValidatedNotNullCheck,
  resolveDroppedIndexTable,
  recordOperation,
} from './postgres-registry.cjs';
import type { FuncCall } from '@pgsql/types';
import type {
  ColumnType,
  MigrationDialect,
  MigrationFinding,
  MigrationOperation,
  MigrationUnit,
} from '../types/migration-operations.cjs';
import type { PgStatementNode } from '../types/pg-statements.cjs';
import type { PostgresRegistry } from '../types/postgres-registry.cjs';

type OperationRule = (
  operation: MigrationOperation,
  unit: MigrationUnit,
  registry: PostgresRegistry,
) => MigrationFinding | null;

const PLACEHOLDER_PATTERN = new RegExp(DYNAMIC_PLACEHOLDER_PREFIX + '\\d+', 'g');
const LOCK_TIMEOUT_STATEMENT = "SET lock_timeout = '5s';";

const NON_TRANSACTIONAL_HOW: Record<string, string> = {
  prisma:
    'in a migration file containing only this statement, because Prisma runs a multi-statement file in one transaction',
  drizzle:
    'outside the Drizzle migrator (for example a separate `psql` step), because it runs every migration in one transaction',
  typeorm:
    'in its own migration class with `transaction = false`, because TypeORM wraps each migration in a transaction',
  knex: 'in its own migration with `exports.config = { transaction: false }`, because Knex wraps each migration in a transaction',
  sequelize: 'in a raw query outside any `sequelize.transaction(...)`',
  'mikro-orm':
    'in its own migration class whose `isTransactional()` returns false, because MikroORM wraps each migration in a transaction',
  sql: 'outside any `BEGIN ... COMMIT` block',
};

const LEAVE_TRANSACTION_FIX: Record<string, string> = {
  prisma: 'Move it to a migration file containing only this statement',
  drizzle: 'Run it outside the Drizzle migrator, which wraps every migration in a transaction',
  typeorm: 'Set `transaction = false` on the migration class',
  knex: 'Add `exports.config = { transaction: false };` to this migration',
  sequelize: 'Run it outside `sequelize.transaction(...)`',
  'mikro-orm': 'Override `isTransactional()` to return false on the migration class',
  sql: 'Move it after `COMMIT`',
};

const LOCK_TAKING_KINDS = new Set([
  'create-index',
  'drop-index',
  'add-column',
  'alter-column-type',
  'set-not-null',
  'add-constraint',
  'drop-constraint',
  'rename-constraint',
  'drop-column',
  'drop-table',
  'rename-column',
  'rename-table',
  'alter-table-other',
  'table-rewrite-command',
  'truncate',
]);

function display(name: string | null | undefined, dialect: MigrationDialect = 'postgres'): string {
  if (!name) return '?';
  return quoteIdentifier(name, dialect).replaceAll(PLACEHOLDER_PATTERN, '${...}');
}

function displaySql(text: string | null | undefined): string {
  return compactSql(text).replaceAll(PLACEHOLDER_PATTERN, '${...}');
}

function frameworkKey(framework: string): string {
  return NON_TRANSACTIONAL_HOW[framework] ? framework : 'sql';
}

// Lock, rewrite and constraint rules apply only to tables that existed before this migration.
function isExistingTable(operation: MigrationOperation): boolean {
  return (
    Boolean(operation.table) &&
    !operation.createdInSameUnit &&
    (operation.assumeTableExists || !containsPlaceholder(operation.table))
  );
}

// A table emptied by TRUNCATE earlier in the same transaction has no rows to scan, rewrite or wait
// on.
function holdsRows(operation: MigrationOperation): boolean {
  return isExistingTable(operation) && !operation.emptiedInSameUnit;
}

function concurrentIndexSql(operation: MigrationOperation): string | null {
  if (operation.builder || operation.sql === null) return null;
  return operation.sql.replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX)\s+/i, '$1 CONCURRENTLY ');
}

// DROP INDEX names no table; it is only known when an earlier scanned migration created the index.
function isDropOfUnknownIndex(operation: MigrationOperation): boolean {
  return operation.kind === 'drop-index' && !operation.table && !operation.concurrent && Boolean(operation.index);
}

function indexNotConcurrent(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
  if (operation.kind === 'drop-index') return dropIndexNotConcurrent(operation, unit);
  if (operation.kind !== 'create-index' || operation.concurrent || operation.onlyParent) return null;
  if (!holdsRows(operation)) return null;
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

function dropIndexNotConcurrent(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
  if (operation.concurrent || containsPlaceholder(operation.index)) return null;
  if (!isDropOfUnknownIndex(operation) && !holdsRows(operation)) return null;
  const subject = operation.table ? `existing table \`${display(operation.table)}\`` : 'its table';
  const fixedSql = operation.builder ? null : concurrentDropSql(operation);
  const fix = operation.builder
    ? builderConcurrentDropFix(unit.framework, operation)
    : 'Use `' + displaySql(fixedSql) + '`';
  const where = operation.inTransaction
    ? NON_TRANSACTIONAL_HOW[frameworkKey(unit.framework)]
    : 'in this migration, which already runs outside a transaction';
  return createFinding(operation, 'migration-index-not-concurrent', {
    message: `\`${displaySql(operation.sql)}\` takes an ACCESS EXCLUSIVE lock on ${subject}, blocking reads and writes while it waits for running queries and while it drops. ${fix} ${where}. \`DROP INDEX CONCURRENTLY\` drops one index per statement and does not support \`CASCADE\`.`,
    suggestion: `${fix} ${where}.`,
    example: { before: displaySql(operation.sql), after: fixedSql ? displaySql(fixedSql) : fix },
  });
}

function concurrentDropSql(operation: MigrationOperation): string | null {
  return operation.sql === null ? null : operation.sql.replace(/^(\s*DROP\s+INDEX)\s+/i, '$1 CONCURRENTLY ');
}

function builderConcurrentDropFix(framework: string, operation: MigrationOperation): string {
  if (framework === 'sequelize')
    return "Pass `{ concurrently: true }` to `queryInterface.removeIndex('" + operation.table + "', ...)`";
  return 'Use a raw `DROP INDEX CONCURRENTLY ...` query';
}

function builderConcurrentFix(framework: string, operation: MigrationOperation): string {
  const table = display(operation.table);
  if (framework === 'sequelize')
    return "Pass `{ concurrently: true }` to `queryInterface.addIndex('" + operation.table + "', ...)`";
  if (framework === 'knex') return "Use `knex.raw('CREATE INDEX CONCURRENTLY ... ON " + table + " (...)')`";
  return "Use `queryRunner.query('CREATE INDEX CONCURRENTLY ... ON " + table + " (...)')`";
}

function concurrentCommandLabel(operation: MigrationOperation): string {
  if (operation.kind === 'create-index') return 'CREATE INDEX CONCURRENTLY';
  if (operation.kind === 'drop-index') return 'DROP INDEX CONCURRENTLY';
  return 'REINDEX ... CONCURRENTLY';
}

function concurrentInTransaction(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
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

const REWRITE_FIX: Record<string, string> = {
  'VACUUM FULL': 'Use `pg_repack` to rebuild the table online, or run it in a maintenance window',
  CLUSTER: 'Use `pg_repack --order-by` to reorder the table online, or run it in a maintenance window',
  REINDEX: 'Use `REINDEX ... CONCURRENTLY` (PostgreSQL 12+) outside a transaction',
};

function tableRewriteCommand(operation: MigrationOperation): MigrationFinding | null {
  if (operation.kind !== 'table-rewrite-command' || operation.concurrent) return null;
  if (operation.table && !holdsRows(operation)) return null;
  const fix = REWRITE_FIX[operation.command ?? ''];
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

function lockTimeoutFix(framework: string): string {
  if (framework === 'typeorm') return `Start \`up()\` with \`await queryRunner.query("${LOCK_TIMEOUT_STATEMENT}")\``;
  if (framework === 'knex') return `Start \`up()\` with \`await knex.raw("${LOCK_TIMEOUT_STATEMENT}")\``;
  if (framework === 'mikro-orm') return `Start \`up()\` with \`this.addSql("${LOCK_TIMEOUT_STATEMENT}")\``;
  if (framework === 'sequelize')
    return `Start \`up()\` with \`await queryInterface.sequelize.query("${LOCK_TIMEOUT_STATEMENT}")\``;
  return `Start the migration with \`${LOCK_TIMEOUT_STATEMENT}\``;
}

// Once per file: the first statement that queues for a lock on an existing table with no
// lock_timeout set before it.
function missingLockTimeout(operations: MigrationOperation[], unit: MigrationUnit): MigrationFinding | null {
  for (const operation of operations) {
    if (operation.kind === 'set-lock-timeout') return null;
    if (!LOCK_TAKING_KINDS.has(operation.kind) || operation.concurrent) continue;
    if (!holdsRows(operation) && !isDropOfUnknownIndex(operation)) continue;
    const fix = lockTimeoutFix(unit.framework);
    const lockTarget = operation.table ? `\`${display(operation.table)}\`` : 'its table';
    return createFinding(operation, 'migration-missing-lock-timeout', {
      message: `\`${displaySql(operation.sql)}\` waits for a lock on ${lockTarget} with no \`lock_timeout\`, and every later query on that table queues behind the wait. ${fix} so a blocked DDL fails fast instead of queueing every query behind it, then retry. Skip this if the migration runner already sets \`lock_timeout\` on its connection.`,
      suggestion: fix + '.',
      example: { before: displaySql(operation.sql), after: `${LOCK_TIMEOUT_STATEMENT} ${displaySql(operation.sql)}` },
    });
  }
  return null;
}

// Functions whose value is fixed for the statement, so PostgreSQL 11+ stores the default without a
// rewrite.
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

const NULLABLE_FIX: Record<string, string> = {
  typeorm: 'Add it with `isNullable: true` (or a constant `default`)',
  sequelize: 'Add it with `allowNull: true` (or a constant `defaultValue`)',
  knex: 'Add it with `.nullable()` (or a constant `.defaultTo(...)`)',
  sql: 'Add it nullable (or with a constant `DEFAULT`, which is instant on PostgreSQL 11+)',
};

const TYPE_NAMES: Record<string, string> = {
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

function builderFix(table: Record<string, string>, framework: string, operation: MigrationOperation): string {
  return operation.builder ? (table[framework] ?? table.sql) : table.sql;
}

function functionName(node: FuncCall): string | undefined {
  return (node.funcname ?? [])
    .map((part: PgStatementNode) => part.String?.sval)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase();
}

// 'dynamic' when a template hole is involved, the first volatile function name, or null.
function isFuncCall(value: unknown): value is FuncCall {
  return Boolean(value) && typeof value === 'object';
}

function volatileFunction(expression: PgStatementNode): string | null {
  if (containsPlaceholder(JSON.stringify(expression))) return 'dynamic';
  let found: string | null = null;
  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if ('FuncCall' in value && isFuncCall(value.FuncCall)) {
      const name = functionName(value.FuncCall);
      if (name === undefined || !NON_VOLATILE_FUNCTIONS.has(name)) {
        found = name ?? 'unknown';
        return;
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(expression);
  return found;
}

function notNullWithoutDefault(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
  if (operation.kind !== 'add-column' || !operation.notNull || operation.hasDefault) return null;
  if (operation.identity || operation.serial || operation.generatedStored || !holdsRows(operation)) return null;
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

function volatileDefaultReason(operation: MigrationOperation): { reason: string; call: string | null } | null {
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

function volatileDefault(operation: MigrationOperation): MigrationFinding | null {
  if (operation.kind !== 'add-column' || !holdsRows(operation)) return null;
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

function typeText(type: ColumnType | null | undefined): string {
  if (!type) return 'a new type';
  const name = String((type.name === null ? undefined : TYPE_NAMES[type.name]) ?? type.name);
  const modifiers = type.modifiers.filter((modifier) => modifier !== null);
  return name + (modifiers.length > 0 ? `(${modifiers.join(',')})` : '') + (type.array ? '[]' : '');
}

function sameModifiers(left: (number | null)[], right: (number | null)[]): boolean {
  return left.length === right.length && left.every((value, index: number) => value === right[index]);
}

function isSafeTypeChange(previous: ColumnType, next: ColumnType): boolean {
  if (previous.array !== next.array) return false;
  if (previous.name === next.name && sameModifiers(previous.modifiers, next.modifiers)) return true;
  const textual = new Set<string | null>(['varchar', 'text']);
  if (next.name === 'text') return textual.has(previous.name);
  if (next.name === 'varchar' && textual.has(previous.name)) {
    if (next.modifiers.length === 0) return true;
    return (
      previous.name === 'varchar' &&
      previous.modifiers.length > 0 &&
      (next.modifiers[0] ?? 0) >= (previous.modifiers[0] ?? 0)
    );
  }
  if (next.name === previous.name && next.name !== null && ['numeric', 'varbit'].includes(next.name)) {
    if (next.modifiers.length === 0) return true;
    if (previous.modifiers.length === 0) return false;
    const sameScale = (next.modifiers[1] ?? 0) === (previous.modifiers[1] ?? 0);
    return sameScale && (next.modifiers[0] ?? 0) >= (previous.modifiers[0] ?? 0);
  }
  return false;
}

function columnTypeRewrite(
  operation: MigrationOperation,
  unit: MigrationUnit,
  registry: PostgresRegistry,
): MigrationFinding | null {
  if (operation.kind !== 'alter-column-type' || !holdsRows(operation)) return null;
  if (containsPlaceholder(operation.columnName) || containsPlaceholder(JSON.stringify(operation.type ?? null)))
    return null;
  const previous =
    (operation.table === null ? undefined : registry.columnTypes.get(operation.table))?.get(operation.columnName) ??
    null;
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
    !previous && next && next.name !== null && WIDENING_TYPES.has(next.name) && !operation.hasUsing
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

function setNotNullScan(
  operation: MigrationOperation,
  unit: MigrationUnit,
  registry: PostgresRegistry,
): MigrationFinding | null {
  if (operation.kind !== 'set-not-null' || !holdsRows(operation)) return null;
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

const CONSTRAINT_LOCKS: Record<string, string> = {
  foreign: 'a SHARE ROW EXCLUSIVE lock on it and on the referenced table, blocking writes to both',
  check: 'an ACCESS EXCLUSIVE lock, blocking reads and writes',
};

function constraintLabel(operation: MigrationOperation): string {
  if (operation.builder) return '`' + displaySql(operation.sql) + '`';
  const kind = operation.constraintType === 'foreign' ? 'FOREIGN KEY' : 'CHECK';
  return (
    '`ADD CONSTRAINT' + (operation.constraintName ? ' ' + display(operation.constraintName) : '') + ' ' + kind + '`'
  );
}

function addedWithoutNotValid(operation: MigrationOperation): MigrationFinding {
  const table = display(operation.table);
  const name = display(operation.constraintName ?? `${operation.table}_constraint`);
  const fix = operation.builder
    ? `Add it with a raw query ending in \`NOT VALID\`, then run \`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name};\` in a later migration`
    : `Add \`NOT VALID\`, then run \`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name};\` in a later migration`;
  return createFinding(operation, 'migration-constraint-not-valid', {
    message: `${constraintLabel(operation)} on existing table \`${table}\` checks every row while holding ${CONSTRAINT_LOCKS[operation.constraintType ?? '']}. ${fix}; validation takes a lock that allows reads and writes. New and updated rows are checked as soon as the \`NOT VALID\` constraint exists.`,
    suggestion: fix + '.',
    example: {
      before: displaySql(operation.sql),
      after: operation.builder
        ? `ALTER TABLE ${table} ADD CONSTRAINT ${name} ... NOT VALID; -- later: VALIDATE CONSTRAINT ${name}`
        : `${displaySql(operation.sql)} NOT VALID; -- later: ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`,
    },
  });
}

function validatedInSameTransaction(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
  if (!operation.inTransaction || !operation.constraintName) return null;
  const position = unit.operations.indexOf(operation);
  const added = unit.operations
    .slice(0, position)
    .some(
      (earlier) =>
        earlier.kind === 'add-constraint' &&
        earlier.notValid &&
        earlier.inTransaction &&
        earlier.constraintName === operation.constraintName,
    );
  if (!added) return null;
  const name = display(operation.constraintName);
  return createFinding(operation, 'migration-constraint-not-valid', {
    message: `\`VALIDATE CONSTRAINT ${name}\` runs in the same transaction as its \`NOT VALID\` add, so the add's lock is held for the whole validation scan and \`NOT VALID\` gains nothing. Move \`VALIDATE CONSTRAINT ${name}\` to a later migration (or commit between the two). The constraint already applies to new rows after the add.`,
    suggestion: `Move \`VALIDATE CONSTRAINT ${name}\` to a later migration.`,
    example: {
      before: `ADD CONSTRAINT ${name} ... NOT VALID; VALIDATE CONSTRAINT ${name}; -- one transaction`,
      after: `ADD CONSTRAINT ${name} ... NOT VALID; -- next migration: VALIDATE CONSTRAINT ${name}`,
    },
  });
}

function constraintNotValid(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
  if (operation.kind === 'validate-constraint') return validatedInSameTransaction(operation, unit);
  if (operation.kind !== 'add-constraint' || operation.notValid || !holdsRows(operation)) return null;
  if (!CONSTRAINT_LOCKS[operation.constraintType ?? '']) return null;
  return addedWithoutNotValid(operation);
}

function constraintWithoutIndex(operation: MigrationOperation): MigrationFinding | null {
  if (operation.kind !== 'add-constraint' || operation.usingIndex || !holdsRows(operation)) return null;
  if (!operation.constraintType || !['unique', 'primary'].includes(operation.constraintType)) return null;
  const table = display(operation.table);
  const kind = operation.constraintType === 'primary' ? 'PRIMARY KEY' : 'UNIQUE';
  const index = display(
    operation.constraintName ?? `${operation.table}_${operation.constraintType === 'primary' ? 'pkey' : 'key'}`,
  );
  const unique = `\`CREATE UNIQUE INDEX CONCURRENTLY ${index} ON ${table} (...);\``;
  const attach = `\`ALTER TABLE ${table} ADD CONSTRAINT ${index} ${kind} USING INDEX ${index};\``;
  const caveat =
    operation.constraintType === 'primary'
      ? ' A primary key also needs NOT NULL columns; prove them first with a validated `CHECK (... IS NOT NULL)`.'
      : ' A duplicate makes the concurrent build fail and leaves an invalid index to drop.';
  return createFinding(operation, 'migration-constraint-without-index', {
    message: `\`ADD ${kind}\` on existing table \`${table}\` builds its index while blocking reads and writes for the whole build. Build the index first with ${unique} (outside a transaction), then ${attach}, which only takes a brief lock.${caveat}`,
    suggestion: `${unique} then ${attach}`,
    example: {
      before: displaySql(operation.sql),
      after: `CREATE UNIQUE INDEX CONCURRENTLY ${index} ON ${table} (...); ALTER TABLE ${table} ADD CONSTRAINT ${index} ${kind} USING INDEX ${index}`,
    },
  });
}

function dropTarget(operation: MigrationOperation, dialect: MigrationDialect): { label: string; subject: string } {
  const table = display(operation.table, dialect);
  if (operation.kind === 'drop-table') return { label: `DROP TABLE ${table}`, subject: `\`${table}\`` };
  const column = display(operation.columnName, dialect);
  return { label: `DROP COLUMN ${column}`, subject: `\`${table}.${column}\`` };
}

function breakingDrop(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
  if (!['drop-column', 'drop-table'].includes(operation.kind) || !isExistingTable(operation)) return null;
  if (operation.renamedInSameUnit) return null;
  const { label, subject } = dropTarget(operation, unit.dialect);
  const fix = 'Remove all reads and writes (and the ORM field), deploy, then drop it in a later release';
  return createFinding(operation, 'migration-breaking-drop', {
    message: `\`${label}\` breaks app versions still running during the deploy, because they still read or write ${subject}. ${fix}. If no deployed version uses it any more, mark it reviewed.`,
    suggestion: fix + '.',
    example: {
      before: `${displaySql(operation.sql)} -- same release as the code change`,
      after: `release N: stop using ${subject.replaceAll('`', '')}; release N+1: ${label}`,
    },
  });
}

function breakingRename(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
  if (!['rename-column', 'rename-table'].includes(operation.kind) || !isExistingTable(operation)) return null;
  if (operation.nameRecreatedInSameUnit) return null;
  const dialect = unit.dialect;
  const table = display(operation.table, dialect);
  const isColumn = operation.kind === 'rename-column';
  const from = isColumn ? display(operation.columnName, dialect) : table;
  const to = display(operation.newName, dialect);
  const fix = isColumn
    ? `Add ${to}, dual-write both columns, switch reads to ${to}, then drop ${from} in a later release`
    : `Create ${to} (or a view named ${from} over it), switch reads and writes, then drop ${from} in a later release`;
  return createFinding(operation, 'migration-breaking-rename', {
    message: `\`RENAME ${isColumn ? `COLUMN ${from}` : table} TO ${to}\` breaks app versions still running during the deploy, because they still use \`${from}\`. ${fix}. If every running version already uses the new name, mark it reviewed.`,
    suggestion: fix + '.',
    example: { before: displaySql(operation.sql), after: `${fix.split(',')[0]}; ...` },
  });
}

function unparsedStatement(operation: MigrationOperation): MigrationFinding | null {
  if (operation.kind !== 'unparsed' || !operation.parseError) return null;
  const { message, line } = operation.parseError;
  const finding = createFinding(operation, 'migration-unparsed', {
    message: `The PostgreSQL parser rejected this statement (\`${message}\` at line ${line}), so no migration rule checked it. Fix the SQL, or review it by hand if it uses grammar from a newer server or an extension.`,
    suggestion: `Check the SQL at line ${line}.`,
    example: { before: displaySql(operation.sql), after: 'SQL that PostgreSQL 18 parses' },
  });
  if (operation.dynamic) finding.contextualReason = 'Statement contains interpolated values the parser cannot see.';
  return finding;
}

const OPERATION_RULES: OperationRule[] = [
  breakingDrop,
  breakingRename,
  unparsedStatement,
  indexNotConcurrent,
  concurrentInTransaction,
  tableRewriteCommand,
  notNullWithoutDefault,
  volatileDefault,
  columnTypeRewrite,
  setNotNullScan,
  constraintNotValid,
  constraintWithoutIndex,
];

const INTERPOLATED_TABLE_REASON =
  'The table name is interpolated, so the checker cannot tell which table this runs on or whether it already holds rows.';

function runRules(operation: MigrationOperation, unit: MigrationUnit, registry: PostgresRegistry): MigrationFinding[] {
  return OPERATION_RULES.map((rule) => rule(operation, unit, registry)).filter(
    (finding): finding is MigrationFinding => finding !== null,
  );
}

// A statement on an interpolated table name is checked as if the table existed, and reported as
// contextual.
function operationFindings(
  operation: MigrationOperation,
  unit: MigrationUnit,
  registry: PostgresRegistry,
): MigrationFinding[] {
  if (!containsPlaceholder(operation.table) || operation.createdInSameUnit) return runRules(operation, unit, registry);
  operation.assumeTableExists = true;
  const findings = runRules(operation, unit, registry);
  delete operation.assumeTableExists;
  for (const finding of findings) finding.contextualReason ??= INTERPOLATED_TABLE_REASON;
  return findings;
}

// unit: { file, framework, operations } with operations already annotated by annotateUnit.
function checkPostgresUnit(
  unit: MigrationUnit,
  registry: PostgresRegistry = createPostgresRegistry(),
): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  for (const operation of unit.operations) {
    resolveDroppedIndexTable(operation, unit, registry);
    findings.push(...operationFindings(operation, unit, registry));
    recordOperation(registry, operation);
  }
  const lockTimeout = missingLockTimeout(unit.operations, unit);
  if (lockTimeout) findings.push(lockTimeout);
  return findings.sort((left, right) => left.line - right.line || left.column - right.column);
}

export {
  checkPostgresUnit,
  createPostgresRegistry,
  breakingDrop,
  breakingRename,
  display,
  displaySql,
  isExistingTable,
};
