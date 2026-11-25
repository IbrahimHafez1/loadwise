import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { median } from './measure.js';
import type { IndexKey, IndexModel, SchemaModel } from '../types/db-model.js';
import type { RoundTrip, SchemaSnapshot, SnapshotIndex, SnapshotTable, SnapshotTables } from '../types/db-snapshot.js';

interface RoundTripOptions {
  runs?: number;
  warmups?: number;
  now?: () => number;
}

interface SnapshotInput {
  dialect: string;
  serverVersion?: string | number;
  roundTrip?: RoundTrip;
  statsAgeDays?: number;
  tables: SnapshotTables;
  capturedAt?: Date;
}

// Version 1 of design 1.4. It holds no URL, host, user, query text or row data.
const snapshotVersion = 1;
const roundTripRuns = 20;
const roundTripWarmups = 3;

/**
 * Times `probe` (SELECT 1 or ping) after warm-up; the median is measured from this host, not the
 * app server.
 */
async function measureRoundTrip(
  probe: () => Promise<unknown>,
  { runs = roundTripRuns, warmups = roundTripWarmups, now = () => performance.now() }: RoundTripOptions = {},
): Promise<RoundTrip> {
  for (let warmup = 0; warmup < warmups; warmup += 1) await probe();
  const durations: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const start = now();
    await probe();
    durations.push(now() - start);
  }
  return { medianMs: Math.round(median(durations) * 1000) / 1000, runs, kind: 'measured', measuredFrom: 'cli-host' };
}

function snapshotKey(key: IndexKey): IndexKey {
  const copy: IndexKey = {};
  if (key.column !== undefined) copy.column = key.column;
  if (key.expression !== undefined) copy.expression = key.expression;
  if (key.opclass !== undefined) copy.opclass = key.opclass;
  if (key.direction !== undefined) copy.direction = key.direction;
  return copy;
}

function snapshotIndex(index: IndexModel) {
  const copy: SnapshotIndex = {
    name: index.name,
    keys: index.keys.map(snapshotKey),
    unique: Boolean(index.unique),
    primary: Boolean(index.primary),
    method: index.method,
  };
  if (index.predicate) copy.predicate = index.predicate;
  return copy;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Converts the model built by checks.cjs (Map of schema.table) to snapshot tables. */
function snapshotTables(model: SchemaModel): SnapshotTables {
  const tables: SnapshotTables = {};
  for (const [key, table] of model) {
    const entry: SnapshotTable = {
      ...(isCount(table.rowEstimate) ? { rowEstimate: table.rowEstimate } : {}),
      ...(isCount(table.sizeBytes) ? { sizeBytes: table.sizeBytes } : {}),
      indexes: table.indexes.map(snapshotIndex),
      foreignKeys: table.foreignKeys.map((foreignKey) => ({
        name: foreignKey.name,
        columns: [...foreignKey.columns],
        references: { table: foreignKey.references.table, columns: [...foreignKey.references.columns] },
      })),
    };
    tables[key] = entry;
  }
  return tables;
}

function buildSnapshot({
  dialect,
  serverVersion,
  roundTrip,
  statsAgeDays,
  tables,
  capturedAt = new Date(),
}: SnapshotInput): SchemaSnapshot {
  return {
    version: snapshotVersion,
    dialect,
    serverVersion: String(serverVersion ?? ''),
    capturedAt: capturedAt.toISOString(),
    ...(roundTrip ? { roundTrip } : {}),
    ...(isCount(statsAgeDays) ? { statsAgeDays: Math.round(statsAgeDays * 10) / 10 } : {}),
    tables,
  };
}

function writeSnapshot(filename: string, snapshot: SchemaSnapshot) {
  fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2) + '\n');
}

export { snapshotVersion, measureRoundTrip, snapshotTables, buildSnapshot, writeSnapshot };
