import type { SchemaSnapshot, SnapshotIndex, SnapshotTable } from '../../lib/performance/types/db-snapshot.js';

interface PartialSnapshotTable extends Partial<Omit<SnapshotTable, 'indexes'>> {
  indexes?: Partial<SnapshotIndex>[];
}

/** A hand-written snapshot as the tests give it: only the members the rule under test reads. */
export interface PartialSnapshot extends Partial<Omit<SchemaSnapshot, 'tables'>> {
  tables: Record<string, PartialSnapshotTable>;
}

// Hands a minimal snapshot to the schema context as-is, so the rules see exactly what the test
// wrote.
export function asSnapshot(partial: PartialSnapshot): SchemaSnapshot {
  // Deliberate: the whole point is a snapshot with members missing, which no type can express.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- a snapshot with members missing cannot be expressed as a type
  return partial as SchemaSnapshot;
}
