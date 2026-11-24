// Apply schema changes in migration order so later rules can use known types, indexes and validated
// checks.
import type { MigrationOperation, MigrationUnit } from '../types/migration-operations.cjs';
import type { CheckName, NotNullCheck, PostgresRegistry } from '../types/postgres-registry.cjs';

function createPostgresRegistry(): PostgresRegistry {
  return { columnTypes: new Map(), notNullChecks: new Map(), indexTables: new Map() };
}

function tableEntry<Key, Value>(map: Map<string, Map<Key, Value>>, table: string): Map<Key, Value> {
  const existing = map.get(table);
  if (existing) return existing;
  const created = new Map<Key, Value>();
  map.set(table, created);
  return created;
}

function renameEntry<Key, Value>(map: Map<Key, Value> | undefined, from: Key, to: Key | null | undefined): void {
  if (!map?.has(from)) return;
  const entry = map.get(from);
  if (to && entry !== undefined) map.set(to, entry);
  map.delete(from);
}

function updateColumnChecks(
  checks: Map<CheckName, NotNullCheck> | undefined,
  column: string | null,
  replacement?: string | null,
): void {
  if (!checks) return;
  for (const [name, check] of checks) {
    if (column && check.column !== column) continue;
    if (column && replacement) check.column = replacement;
    else checks.delete(name);
  }
}

function updateConstraintName(
  checks: Map<CheckName, NotNullCheck> | undefined,
  oldName: CheckName,
  newName: string | null | undefined,
): void {
  if (!checks) return;
  if (checks.has(oldName)) {
    renameEntry(checks, oldName, newName);
    return;
  }
  // PostgreSQL picks names for unnamed checks. An unknown name may refer to any one of them.
  for (const name of checks.keys()) if (typeof name === 'symbol') checks.delete(name);
}

// Repoints (or, with `to` null, forgets) the indexes of a renamed or dropped table.
function renameIndexTable(indexTables: Map<string, string>, from: string, to: string | null | undefined): void {
  for (const [index, table] of indexTables) {
    if (table !== from) continue;
    if (to) indexTables.set(index, to);
    else indexTables.delete(index);
  }
}

// A plain DROP INDEX gets the table of the scanned migration that created the index, and that
// table's unit context.
function resolveDroppedIndexTable(
  operation: MigrationOperation,
  unit: MigrationUnit,
  registry: PostgresRegistry,
): void {
  if (operation.kind !== 'drop-index' || operation.table || !operation.index) return;
  const table = registry.indexTables.get(operation.index);
  if (!table) return;
  const earlier = unit.operations.slice(0, unit.operations.indexOf(operation));
  operation.table = table;
  operation.createdInSameUnit = earlier.some(
    (previous: MigrationOperation) =>
      (previous.table === table && (previous.kind === 'create-table' || previous.createdInSameUnit)) ||
      (previous.kind === 'create-index' && previous.index === operation.index),
  );
  operation.emptiedInSameUnit = earlier.some(
    (previous) => previous.kind === 'truncate' && previous.table === table && previous.inTransaction,
  );
}

function recordOperation(registry: PostgresRegistry, operation: MigrationOperation): void {
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
      updateColumnChecks(registry.notNullChecks.get(table), columnName);
      break;
    case 'rename-column':
      renameEntry(registry.columnTypes.get(table), columnName, operation.newName);
      updateColumnChecks(registry.notNullChecks.get(table), columnName, operation.newName);
      break;
    case 'rename-table':
      renameEntry(registry.columnTypes, table, operation.newName);
      renameEntry(registry.notNullChecks, table, operation.newName);
      renameIndexTable(registry.indexTables, table, operation.newName);
      break;
    case 'drop-table':
      registry.columnTypes.delete(table);
      registry.notNullChecks.delete(table);
      renameIndexTable(registry.indexTables, table, null);
      break;
    case 'create-index':
      if (operation.index) registry.indexTables.set(operation.index, table);
      break;
    case 'drop-index':
      if (operation.index) registry.indexTables.delete(operation.index);
      break;
    case 'add-constraint':
      if (operation.checkNotNullColumn) {
        tableEntry(registry.notNullChecks, table).set(operation.constraintName ?? Symbol(), {
          column: operation.checkNotNullColumn,
          validated: !operation.notValid,
        });
      }
      break;
    case 'drop-constraint':
    case 'rename-constraint':
      updateConstraintName(registry.notNullChecks.get(table), operation.constraintName, operation.newName);
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

function hasValidatedNotNullCheck(registry: PostgresRegistry, table: string | null, column: string | null): boolean {
  const checks = table === null ? undefined : registry.notNullChecks.get(table);
  return [...(checks?.values() ?? [])].some((check) => check.column === column && check.validated);
}

export { createPostgresRegistry, hasValidatedNotNullCheck, resolveDroppedIndexTable, recordOperation };
