// Version 1 of the schema snapshot `db --schema-snapshot` writes. It holds no URL, host, user,
// query text or row data.
import type { IndexKey } from './db-model.js';

export interface SnapshotIndex {
  name: string;
  keys: IndexKey[];
  unique: boolean;
  primary: boolean;
  method: string;
  predicate?: string;
}

export interface SnapshotForeignKey {
  name: string;
  columns: string[];
  references: { table: string; columns: string[] };
}

export interface SnapshotTable {
  rowEstimate?: number;
  sizeBytes?: number;
  indexes: SnapshotIndex[];
  foreignKeys: SnapshotForeignKey[];
}

export type SnapshotTables = Record<string, SnapshotTable>;

/** Round-trip latency of a trivial probe, measured from the CLI host. */
export interface RoundTrip {
  medianMs: number;
  runs: number;
  kind: 'measured';
  measuredFrom: 'cli-host';
}

export interface SchemaSnapshot {
  version: number;
  dialect: string;
  serverVersion: string;
  capturedAt: string;
  roundTrip?: RoundTrip;
  statsAgeDays?: number;
  tables: SnapshotTables;
}
