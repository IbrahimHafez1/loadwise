'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createGateway } = require('../lib/db/gateway.cjs');
const { measureControl, statements } = require('../lib/db/pg-catalog.cjs');
const {
  preconnectRefusals,
  serverRefusals,
  tableRefusal,
  lockWarning,
  median,
  measureCandidate,
  assertNoIndexesLeft,
  createIndexNamer,
  describeMeasurement,
  MeasureRefusal,
} = require('../lib/db/measure.cjs');
const {
  createRecordingAdapter,
  createSignals,
  disallowedPostgresStatements,
  unbalancedTransactions,
} = require('./db-fake-driver.cjs');

const candidate = { table: { schema: 'public', name: 'orders', rowEstimate: 400_000 }, columns: ['customer_id'] };

function analyzedPlan(executionMs, nodeType, rows, removed, hit, read) {
  return [
    {
      Plan: {
        'Node Type': nodeType,
        'Relation Name': 'orders',
        'Actual Rows': rows,
        'Actual Loops': 1,
        'Rows Removed by Filter': removed,
        'Shared Hit Blocks': hit,
        'Shared Read Blocks': read,
      },
      'Execution Time': executionMs,
    },
  ];
}

test('refuses without the confirmation flag, for production-looking names, and for non-Postgres engines', () => {
  assert.deepEqual(
    preconnectRefusals({
      engine: 'postgres',
      confirmed: true,
      envVarNames: ['STAGING_DATABASE_URL'],
      databaseName: 'shop',
    }),
    [],
  );
  assert.match(
    preconnectRefusals({ engine: 'postgres', confirmed: false }).join(' '),
    /--i-understand-this-locks-tables/,
  );
  assert.match(
    preconnectRefusals({ engine: 'postgres', confirmed: true, envVarNames: ['PROD_DATABASE_URL'] }).join(' '),
    /`PROD_DATABASE_URL`, whose name looks like production/,
  );
  assert.match(
    preconnectRefusals({
      engine: 'postgres',
      confirmed: true,
      envVarNames: ['DB_HOST', 'DB_NAME'],
      databaseName: 'shop_Production',
    }).join(' '),
    /database whose name looks like production/,
  );
  assert.match(preconnectRefusals({ engine: 'mysql', confirmed: true }).join(' '), /PostgreSQL only/);
});

test('refuses replicas and production-named databases reported by the server', () => {
  assert.deepEqual(serverRefusals({ databaseName: 'staging', inRecovery: false }), []);
  assert.match(serverRefusals({ databaseName: 'staging', inRecovery: true }).join(' '), /replica/);
  assert.match(serverRefusals({ databaseName: 'appprod', inRecovery: false }).join(' '), /production/);
  assert.match(serverRefusals({ databaseName: 'staging' }).join(' '), /replica/);
});

test('refuses tables above 5,000,000 estimated rows or of unknown size', () => {
  assert.equal(tableRefusal({ schema: 'public', name: 'orders', rowEstimate: 5_000_000 }), undefined);
  assert.match(
    tableRefusal({ schema: 'public', name: 'events', rowEstimate: 5_000_001 }),
    /above the 5,000,000-row limit/,
  );
  assert.match(tableRefusal({ schema: 'public', name: 'fresh' }), /size is unknown/);
  assert.match(
    lockWarning(candidate.table),
    /SHARE lock on `public\.orders` that blocks writes to it until the rollback/,
  );
});

test('measures medians before and after an index built and rolled back in one transaction', async () => {
  let analyzed = 0;
  const timings = [40, 44, 42, 0.5, 0.3, 0.4];
  const adapter = createRecordingAdapter({
    responses: {
      explain: () => {
        const run = analyzed++;
        return [
          {
            'QUERY PLAN':
              run < 3
                ? analyzedPlan(timings[run], 'Seq Scan', 3, 399_997, 10, 2_900)
                : analyzedPlan(timings[run], 'Index Scan', 3, 0, 4, 0),
          },
        ];
      },
    },
  });
  const signals = createSignals();
  const gateway = createGateway(adapter, { allowAnalyze: true, allowMeasure: true, signals, exit: signals.exit });
  const result = await measureCandidate(gateway, {
    sql: 'SELECT * FROM orders WHERE customer_id = 7',
    candidate,
    runs: 3,
    indexName: 'backend_perf_check_42_1',
  });
  assert.deepEqual(result.impact, {
    kind: 'measured',
    before: 42,
    after: 0.4,
    unit: 'ms',
    method: 'median of 3 EXPLAIN ANALYZE runs, index built inside a rolled-back transaction',
  });
  assert.equal(
    describeMeasurement(result),
    'rows examined 400,000 -> 3 (measured); shared buffers hit/read 10/2,900 -> 4/0 (measured)',
  );
  const texts = adapter.sent.map(({ text }) => text);
  const measureStart = texts.indexOf(measureControl.begin);
  assert.deepEqual(texts.slice(measureStart, measureStart + 5), [
    measureControl.begin,
    measureControl.localLockTimeout,
    measureControl.localStatementTimeout,
    'CREATE INDEX "backend_perf_check_42_1" ON "public"."orders" ("customer_id")',
    measureControl.readOnly,
  ]);
  assert.equal(texts.at(-1), measureControl.rollback);
  assert.equal(texts.filter((text) => text.startsWith('CREATE')).length, 1);
  assert.deepEqual(await disallowedPostgresStatements(adapter.sent, { allowMeasure: true }), []);
  assert.equal(unbalancedTransactions(adapter.sent), false);
});

test('after the run, an index this process named that still exists is an error', async () => {
  const adapter = createRecordingAdapter({
    responses: { indexesNamed: (params) => [{ remaining: params[0].length - 1 }] },
  });
  const gateway = createGateway(adapter, { signals: createSignals() });
  await assertNoIndexesLeft(gateway, ['backend_perf_check_1_1']);
  await assert.rejects(assertNoIndexesLeft(gateway, ['a', 'b']), MeasureRefusal);
  assert.ok(adapter.sent.some(({ text }) => text === statements.indexesNamed));
});

test('index names are unique per process and match the guarded prefix', () => {
  const next = createIndexNamer(77);
  assert.equal(next(), 'backend_perf_check_77_1');
  assert.equal(next(), 'backend_perf_check_77_2');
  assert.equal(median([3, 1, 2, 10]), 2.5);
});
