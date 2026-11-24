// Display helpers and table-existence checks shared by the PostgreSQL migration rule modules.
import { DYNAMIC_PLACEHOLDER_PREFIX, compactSql, containsPlaceholder, quoteIdentifier } from './operations.cjs';
import type { MigrationDialect, MigrationOperation } from '../types/migration-operations.cjs';

const PLACEHOLDER_PATTERN = new RegExp(DYNAMIC_PLACEHOLDER_PREFIX + '\\d+', 'g');

export function display(name: string | null | undefined, dialect: MigrationDialect = 'postgres'): string {
  if (!name) return '?';
  return quoteIdentifier(name, dialect).replaceAll(PLACEHOLDER_PATTERN, '${...}');
}

export function displaySql(text: string | null | undefined): string {
  return compactSql(text).replaceAll(PLACEHOLDER_PATTERN, '${...}');
}

// Lock, rewrite and constraint rules apply only to tables that existed before this migration.
export function isExistingTable(operation: MigrationOperation): boolean {
  return (
    Boolean(operation.table) &&
    !operation.createdInSameUnit &&
    (operation.assumeTableExists || !containsPlaceholder(operation.table))
  );
}

// A table emptied by TRUNCATE earlier in the same transaction has no rows to scan, rewrite or wait
// on.
export function holdsRows(operation: MigrationOperation): boolean {
  return isExistingTable(operation) && !operation.emptiedInSameUnit;
}
