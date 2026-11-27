// What the plan estimates, HypoPG, `--measure` and the `db` CLI hand to one another.
import type { DbImpact, TableModel } from './db-model.js';

/** A sequential scan whose filter names columns an index could serve. */
export interface SeqScanCandidate {
  table: SizedTable;
  columns: string[];
  planRows?: number;
}

/** Planner cost with and without a hypothetical index (HypoPG). */
export interface HypotheticalResult {
  before: number | undefined;
  after: number | undefined;
  used: boolean;
}

/** Where a `--queries` statement lives. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** What `--measure` observed for one candidate index. */
export interface Measurement {
  impact: DbImpact;
  rowsExamined: { before: number; after: number };
  sharedBuffers: { before: BufferCounts; after: BufferCounts };
}

interface BufferCounts {
  hit: number;
  read: number;
}

/** A table whose size estimate is known, which every plan-based candidate requires. */
export type SizedTable = TableModel & { rowEstimate: number };

/** A MySQL full table scan large enough to matter. */
export interface MysqlFullScan {
  table: SizedTable;
  rowsPerScan: number | undefined;
}
