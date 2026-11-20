'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { median } = require('./measure.cjs');

// Version 1 of design 1.4. It holds no URL, host, user, query text or row data.
const snapshotVersion = 1;
const roundTripRuns = 20;
const roundTripWarmups = 3;

/** Times `probe` (SELECT 1 or ping) after warm-up; the median is measured from this host, not the app server. */
async function measureRoundTrip(
  probe,
  { runs = roundTripRuns, warmups = roundTripWarmups, now = () => performance.now() } = {},
) {
  for (let warmup = 0; warmup < warmups; warmup += 1) await probe();
  const durations = [];
  for (let run = 0; run < runs; run += 1) {
    const start = now();
    await probe();
    durations.push(now() - start);
  }
  return { medianMs: Math.round(median(durations) * 1000) / 1000, runs, kind: 'measured', measuredFrom: 'cli-host' };
}

function snapshotKey(key) {
  const copy = {};
  for (const field of ['column', 'expression', 'opclass', 'direction']) {
    if (key[field] !== undefined) copy[field] = key[field];
  }
  return copy;
}

function snapshotIndex(index) {
  const copy = {
    name: index.name,
    keys: index.keys.map(snapshotKey),
    unique: Boolean(index.unique),
    primary: Boolean(index.primary),
    method: index.method,
  };
  if (index.predicate) copy.predicate = index.predicate;
  return copy;
}

function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Converts the model built by checks.cjs (Map of schema.table) to snapshot tables. */
function snapshotTables(model) {
  const tables = {};
  for (const [key, table] of model) {
    const entry = {};
    if (isCount(table.rowEstimate)) entry.rowEstimate = table.rowEstimate;
    if (isCount(table.sizeBytes)) entry.sizeBytes = table.sizeBytes;
    entry.indexes = table.indexes.map(snapshotIndex);
    entry.foreignKeys = table.foreignKeys.map((foreignKey) => ({
      name: foreignKey.name,
      columns: [...foreignKey.columns],
      references: { table: foreignKey.references.table, columns: [...foreignKey.references.columns] },
    }));
    tables[key] = entry;
  }
  return tables;
}

function buildSnapshot({ dialect, serverVersion, roundTrip, statsAgeDays, tables, capturedAt = new Date() }) {
  const snapshot = {
    version: snapshotVersion,
    dialect,
    serverVersion: String(serverVersion ?? ''),
    capturedAt: capturedAt.toISOString(),
  };
  if (roundTrip) snapshot.roundTrip = roundTrip;
  if (isCount(statsAgeDays)) snapshot.statsAgeDays = Math.round(statsAgeDays * 10) / 10;
  snapshot.tables = tables;
  return snapshot;
}

function writeSnapshot(filename, snapshot) {
  fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2) + '\n');
}

module.exports = { snapshotVersion, measureRoundTrip, snapshotTables, buildSnapshot, writeSnapshot };
