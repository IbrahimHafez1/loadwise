import assert from 'node:assert/strict';
import test from 'node:test';
import { createGateway, GatewayRefusal } from '../../lib/performance/db/gateway.js';
import { control, measureControl, sessionSetup, statements } from '../../lib/performance/db/pg-catalog.js';
import {
  createRecordingAdapter,
  createSignals,
  disallowedPostgresStatements,
  unbalancedTransactions,
} from './db-fake-driver.js';

const plan = [{ Plan: { 'Node Type': 'Seq Scan', 'Total Cost': 10 } }];

function setup(options = {}, responses = {}) {
  const adapter = createRecordingAdapter({ responses: { explain: [{ 'QUERY PLAN': plan }], ...responses } });
  const signals = createSignals();
  const gateway = createGateway(adapter, { signals, exit: signals.exit, ...options });
  return { adapter, signals, gateway, texts: () => adapter.sent.map(({ text }) => text) };
}

test('the session is made read-only with timeouts before anything else', async () => {
  const { gateway, texts } = setup();
  await gateway.open();
  assert.deepEqual(texts(), [...sessionSetup]);
  assert.ok(texts().includes('SET default_transaction_read_only = on'));
});

test('catalog statements run inside a read-only transaction that is rolled back', async () => {
  const { gateway, texts } = setup({}, { roundTrip: [{ '?column?': 1 }] });
  assert.deepEqual(await gateway.catalog('roundTrip'), [{ '?column?': 1 }]);
  assert.deepEqual(texts(), [
    control.begin,
    control.localStatementTimeout,
    control.localLockTimeout,
    statements.roundTrip,
    control.rollback,
  ]);
  await assert.rejects(gateway.catalog('DROP TABLE users'), GatewayRefusal);
  assert.equal(texts().length, 5);
});

test('4.2 (a): every statement sent is a catalog constant, a control statement or a validated EXPLAIN', async () => {
  const { gateway, adapter } = setup({ allowAnalyze: true });
  await gateway.open();
  await gateway.catalog('tables');
  await gateway.unit(async () => {
    await gateway.catalog('hypopgCreateIndex', ['CREATE INDEX ON "public"."orders" ("customer_id")']);
    await gateway.explain('SELECT * FROM orders WHERE customer_id = $1', { generic: true });
    await gateway.catalog('hypopgReset');
  });
  await gateway.explain('UPDATE orders SET total = 1 WHERE id = $1', { generic: true });
  await gateway.explain('SELECT * FROM orders WHERE id = 7;', { analyze: true });
  assert.deepEqual(await disallowedPostgresStatements(adapter.sent), []);
  assert.equal(unbalancedTransactions(adapter.sent), false);
});

test('4.2 (b): EXPLAIN ANALYZE of anything but a plain SELECT throws before sending', async () => {
  const { gateway, adapter } = setup({ allowAnalyze: true });
  const refused = [
    'DELETE FROM orders',
    'UPDATE orders SET total = 0',
    'INSERT INTO orders DEFAULT VALUES',
    'SELECT * FROM orders FOR UPDATE',
    'SELECT * INTO copy FROM orders',
    'WITH gone AS (DELETE FROM orders RETURNING id) SELECT * FROM gone',
  ];
  for (const sql of refused) await assert.rejects(gateway.explain(sql, { analyze: true }), GatewayRefusal, sql);
  for (const sql of ['DROP TABLE orders', 'SELECT 1; DROP TABLE orders', 'VACUUM orders', 'SELEC 1', '']) {
    await assert.rejects(gateway.explain(sql), GatewayRefusal, sql);
  }
  assert.deepEqual(adapter.sent, []);
});

test('4.2 (c): no ANALYZE token is sent without --analyze or --measure', async () => {
  const { gateway, adapter } = setup();
  await assert.rejects(gateway.explain('SELECT 1', { analyze: true }), /needs --analyze/);
  await gateway.explain('SELECT * FROM orders WHERE id = $1', { generic: true });
  await gateway.explain('SELECT 1');
  const texts = adapter.sent.map(({ text }) => text);
  assert.ok(texts.every((text) => !/ANALYZE/i.test(text)));
  assert.ok(texts.includes('EXPLAIN (GENERIC_PLAN, FORMAT JSON) SELECT * FROM orders WHERE id = $1'));
  assert.ok(texts.includes('EXPLAIN (FORMAT JSON) SELECT 1'));
  await assert.rejects(
    gateway.measureTransaction(async () => {}),
    /needs --measure/,
  );
});

test('explain returns the parsed plan document', async () => {
  const { gateway } = setup({}, { explain: [{ 'QUERY PLAN': JSON.stringify(plan) }] });
  assert.deepEqual(await gateway.explain('SELECT 1'), plan);
});

test('4.2 (d): ROLLBACK follows BEGIN when the body throws', async () => {
  const failure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const { gateway, adapter, texts } = setup(
    {},
    {
      tables: () => {
        throw failure;
      },
    },
  );
  await assert.rejects(gateway.catalog('tables'), failure);
  assert.equal(texts().at(-1), control.rollback);
  assert.equal(unbalancedTransactions(adapter.sent), false);
  assert.equal(adapter.destroyed, false);
});

test('4.2 (d): a failed ROLLBACK destroys the connection instead of reusing it', async () => {
  const { gateway, adapter } = setup(
    {},
    {
      ROLLBACK: () => {
        throw new Error('connection lost');
      },
    },
  );
  await gateway.catalog('roundTrip');
  assert.equal(adapter.destroyed, true);
  await assert.rejects(gateway.catalog('roundTrip'), /closed after an error/);
});

test('4.2 (d): SIGINT during a transaction sends ROLLBACK, destroys the session and exits 130', async () => {
  let release: (value?: unknown) => void = () => {};
  const { gateway, adapter, signals, texts } = setup(
    {},
    { tables: () => new Promise((resolve) => (release = resolve)) },
  );
  const pending = gateway.catalog('tables');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.listenerCount('SIGINT'), 1);
  signals.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(texts().at(-1), control.rollback);
  assert.equal(adapter.destroyed, true);
  assert.deepEqual(signals.exitCodes, [130]);
  release([]);
  await pending;
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('a measure transaction builds the index, turns read-only, and always rolls back', async () => {
  const { gateway, adapter, texts } = setup({ allowAnalyze: true, allowMeasure: true });
  await gateway.measureTransaction(async (transaction) => {
    await transaction.createIndex({
      schema: 'public',
      table: 'orders',
      columns: ['customer_id'],
      name: 'loadwise_measure_1',
    });
    await transaction.readOnly();
    await transaction.explainAnalyze('SELECT * FROM orders WHERE customer_id = 7');
    await assert.rejects(transaction.explainAnalyze('DELETE FROM orders'), GatewayRefusal);
  });
  assert.deepEqual(texts(), [
    measureControl.begin,
    measureControl.localLockTimeout,
    measureControl.localStatementTimeout,
    'CREATE INDEX "loadwise_measure_1" ON "public"."orders" ("customer_id")',
    measureControl.readOnly,
    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE customer_id = 7',
    measureControl.rollback,
  ]);
  assert.deepEqual(await disallowedPostgresStatements(adapter.sent, { allowMeasure: true }), []);
  assert.equal(adapter.destroyed, false);
});

test('a failed measure transaction rolls back and destroys the connection', async () => {
  const { gateway, adapter, texts } = setup({ allowAnalyze: true, allowMeasure: true });
  await assert.rejects(
    gateway.measureTransaction(async () => {
      throw new Error('lock timeout');
    }),
    /lock timeout/,
  );
  assert.equal(texts().at(-1), measureControl.rollback);
  assert.equal(adapter.destroyed, true);
});

test('SIGINT during a measure transaction rolls back before exiting', async () => {
  let release: (value?: unknown) => void = () => {};
  const { gateway, adapter, signals, texts } = setup({ allowAnalyze: true, allowMeasure: true });
  const pending = gateway.measureTransaction(() => new Promise((resolve) => (release = resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  signals.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(texts().at(-1), measureControl.rollback);
  assert.equal(adapter.destroyed, true);
  assert.deepEqual(signals.exitCodes, [130]);
  release();
  await pending.catch(() => {});
});
