'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildPostgresModel } = require('../lib/db/checks.cjs');
const { measureRoundTrip, snapshotTables, buildSnapshot, writeSnapshot } = require('../lib/db/snapshot.cjs');
const { loadSnapshot } = require('../lib/schema/context.cjs');

function catalog() {
  return {
    tables: [
      {
        schema_name: 'public',
        table_name: 'orders',
        row_estimate: '2400000',
        size_bytes: '524288000',
        n_live_tup: '2400000',
      },
      { schema_name: 'public', table_name: 'fresh', row_estimate: '-1', size_bytes: '8192' },
    ],
    columns: [],
    indexes: [
      {
        schema_name: 'public',
        table_name: 'orders',
        index_name: 'orders_lower_email_idx',
        method: 'btree',
        is_unique: false,
        is_primary: false,
        backs_constraint: false,
        predicate: '(deleted_at IS NULL)',
        key_columns: [null, 'created_at'],
        key_definitions: ['lower(email)', 'created_at'],
        key_opclasses: ['text_ops', 'timestamptz_ops'],
        key_descending: [false, true],
        idx_scan: '4',
        size_bytes: '8192',
      },
    ],
    foreignKeys: [
      {
        schema_name: 'public',
        table_name: 'orders',
        constraint_name: 'orders_customer_id_fkey',
        columns: ['customer_id'],
        referenced_schema: 'public',
        referenced_table: 'customers',
        referenced_columns: ['id'],
      },
    ],
  };
}

test('the round trip is the median of timed probes after warm-up, labelled measured from the CLI host', async () => {
  let calls = 0;
  const clock = [0, 1.5, 10, 10.5, 20, 29];
  const result = await measureRoundTrip(
    async () => {
      calls += 1;
    },
    { runs: 3, warmups: 2, now: () => clock.shift() },
  );
  assert.equal(calls, 5);
  assert.deepEqual(result, { medianMs: 1.5, runs: 3, kind: 'measured', measuredFrom: 'cli-host' });
});

test('a snapshot written by db is read back by the schema context reader', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-db-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'snapshot.json');
  const snapshot = buildSnapshot({
    dialect: 'postgres',
    serverVersion: '18.7',
    roundTrip: { medianMs: 1.8, runs: 20, kind: 'measured', measuredFrom: 'cli-host' },
    statsAgeDays: 12.345,
    tables: snapshotTables(buildPostgresModel(catalog())),
    capturedAt: new Date('2026-11-18T09:30:00Z'),
  });
  writeSnapshot(filename, snapshot);
  const loaded = loadSnapshot(filename);
  assert.deepEqual(loaded, snapshot);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.statsAgeDays, 12.3);
  assert.equal(loaded.capturedAt, '2026-11-18T09:30:00.000Z');
  assert.deepEqual(loaded.tables['public.orders'], {
    rowEstimate: 2_400_000,
    sizeBytes: 524_288_000,
    indexes: [
      {
        name: 'orders_lower_email_idx',
        keys: [
          { expression: 'lower(email)', opclass: 'text_ops' },
          { column: 'created_at', opclass: 'timestamptz_ops', direction: 'desc' },
        ],
        unique: false,
        primary: false,
        method: 'btree',
        predicate: '(deleted_at IS NULL)',
      },
    ],
    foreignKeys: [
      {
        name: 'orders_customer_id_fkey',
        columns: ['customer_id'],
        references: { table: 'public.customers', columns: ['id'] },
      },
    ],
  });
  // reltuples -1 with no live-tuple count: the size is unknown and simply left out.
  assert.deepEqual(loaded.tables['public.fresh'], { sizeBytes: 8192, indexes: [], foreignKeys: [] });
  assert.deepEqual(Object.keys(loaded), [
    'version',
    'dialect',
    'serverVersion',
    'capturedAt',
    'roundTrip',
    'statsAgeDays',
    'tables',
  ]);
});
