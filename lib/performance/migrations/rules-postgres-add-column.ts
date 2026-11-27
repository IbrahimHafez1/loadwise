// PostgreSQL migration rules for ADD COLUMN: NOT NULL without a default and volatile defaults.
import { containsPlaceholder, createFinding } from './operations.js';
import { display, displaySql, holdsRows } from './rules-postgres-shared.js';
import type { FuncCall } from '@pgsql/types';
import type { MigrationFinding, MigrationOperation, MigrationUnit } from '../types/migration-operations.js';
import type { PgStatementNode } from '../types/pg-statements.js';

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

export function notNullWithoutDefault(operation: MigrationOperation, unit: MigrationUnit): MigrationFinding | null {
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

export function volatileDefault(operation: MigrationOperation): MigrationFinding | null {
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
