// What the Postgres migration rules know about the schema after the migrations scanned so far.
import type { ColumnType } from './migration-operations.cjs';

/**
 * A named CHECK (col IS NOT NULL); unnamed ones are keyed by a symbol because Postgres picks their
 * names.
 */
export type CheckName = string | symbol | null | undefined;

export interface NotNullCheck {
  column: string;
  validated: boolean;
}

export interface PostgresRegistry {
  columnTypes: Map<string, Map<string | null, ColumnType | null>>;
  notNullChecks: Map<string, Map<CheckName, NotNullCheck>>;
  indexTables: Map<string, string>;
}
