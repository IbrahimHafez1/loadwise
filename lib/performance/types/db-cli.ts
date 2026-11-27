// Shared shapes of `loadwise perf db`: its options, query statements and inspection results.
import type { DbEngine, Redactor } from './db-connection.js';
import type { DbFinding } from './db-model.js';
import type { SourceLocation } from './db-plan-findings.js';
import type { RoundTrip, SnapshotTables } from './db-snapshot.js';

/** The options of `loadwise perf db` after validation. */
export interface DbOptions {
  'url-env'?: string;
  'env-file'?: string;
  engine?: DbEngine;
  'schema-snapshot'?: string;
  top: number;
  queries?: string;
  analyze?: boolean;
  measure?: boolean;
  'i-understand-this-locks-tables'?: boolean;
  runs: number;
  'include-contextual'?: boolean;
  ignore: Set<string>;
  json?: boolean;
  help?: boolean;
}

/** A concrete statement from `--queries`, with where it was written. */
export interface DbQuery extends SourceLocation {
  sql: string;
}

/**
 * What every inspection shares: the parsed options, the statements to explain and the notes
 * collected so far.
 */
export interface InspectContext {
  options: DbOptions;
  queries: DbQuery[];
  notes: string[];
  redact: Redactor;
  stderr: (line: string) => unknown;
  measuredIndexNames: string[];
  nextIndexName: () => string;
}

export interface ServerInfoRow {
  version: string;
  database_name: string;
  version_num?: number;
  in_recovery?: boolean;
}

/** The outcome of inspecting one database, before findings are identified and filtered. */
export interface Inspection {
  serverVersion: string;
  statsAgeDays?: number;
  findings: DbFinding[];
  tables: SnapshotTables;
  roundTrip: RoundTrip;
  notes: string[];
}

export type InspectionWithoutNotes = Omit<Inspection, 'notes'>;
