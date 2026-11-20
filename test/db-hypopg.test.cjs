'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createGateway } = require('../lib/db/gateway.cjs');
const { control, statements } = require('../lib/db/pg-catalog.cjs');
const { hypopgAvailable, evaluateHypotheticalIndex, missingNote } = require('../lib/db/hypopg.cjs');
const {
  createRecordingAdapter,
  createSignals,
  disallowedPostgresStatements,
  unbalancedTransactions,
} = require('./db-fake-driver.cjs');

const candidate = {
  table: { schema: 'public', name: 'orders' },
  columns: ['customer_id', 'created_at'],
};
const seqScanPlan = [{ Plan: { 'Node Type': 'Seq Scan', 'Total Cost': 48_210.5 } }];
const indexPlan = [
  { Plan: { 'Node Type': 'Index Scan', 'Index Name': '<16401>btree_orders_customer_id', 'Total Cost': 8.44 } },
];

function setup(responses) {
  let explains = 0;
  const adapter = createRecordingAdapter({
    responses: {
      explain: () => [{ 'QUERY PLAN': explains++ === 0 ? seqScanPlan : indexPlan }],
      hypopgCreateIndex: [{ indexrelid: 16401, indexname: '<16401>btree_orders_customer_id' }],
      ...responses,
    },
  });
  const signals = createSignals();
  return { adapter, gateway: createGateway(adapter, { signals, exit: signals.exit }) };
}

test('detects the extension from pg_extension rows', () => {
  assert.equal(hypopgAvailable([{ name: 'plpgsql' }, { name: 'hypopg' }]), true);
  assert.equal(hypopgAvailable([{ name: 'plpgsql' }]), false);
  assert.match(missingNote, /HypoPG is not installed/);
});

test('costs the plan before and after a hypothetical index in one read-only transaction, then resets', async () => {
  const { adapter, gateway } = setup();
  const result = await evaluateHypotheticalIndex(gateway, {
    sql: 'SELECT * FROM orders WHERE customer_id = $1 AND created_at > $2',
    generic: true,
    candidate,
  });
  assert.deepEqual(result, { before: 48_210.5, after: 8.44, used: true });
  const texts = adapter.sent.map(({ text }) => text);
  assert.deepEqual(texts.slice(0, 3), [control.begin, control.localStatementTimeout, control.localLockTimeout]);
  assert.equal(texts.filter((text) => text === control.begin).length, 1);
  const create = adapter.sent.find(({ text }) => text === statements.hypopgCreateIndex);
  assert.deepEqual(create.params, ['CREATE INDEX ON "public"."orders" ("customer_id", "created_at")']);
  assert.deepEqual(texts.slice(-2), [statements.hypopgReset, control.rollback]);
  assert.deepEqual(await disallowedPostgresStatements(adapter.sent), []);
  assert.equal(unbalancedTransactions(adapter.sent), false);
  assert.ok(texts.every((text) => !/ANALYZE/.test(text)));
});

test('an index the planner ignores is reported as unused', async () => {
  const { gateway } = setup({ explain: [{ 'QUERY PLAN': seqScanPlan }] });
  const result = await evaluateHypotheticalIndex(gateway, {
    sql: 'SELECT * FROM orders WHERE status = $1',
    generic: true,
    candidate,
  });
  assert.deepEqual(result, { before: 48_210.5, after: 48_210.5, used: false });
});

test('a failure after creating the index still resets it, retrying outside the aborted transaction', async () => {
  let resets = 0;
  let explains = 0;
  const { adapter, gateway } = setup({
    explain: () => {
      if (explains++ > 0) throw new Error('canceling statement due to statement timeout');
      return [{ 'QUERY PLAN': seqScanPlan }];
    },
    hypopgReset: () => {
      if (resets++ === 0) throw new Error('current transaction is aborted');
      return [{}];
    },
  });
  await assert.rejects(
    evaluateHypotheticalIndex(gateway, { sql: 'SELECT 1', generic: false, candidate }),
    /statement timeout/,
  );
  assert.equal(resets, 2);
  assert.equal(unbalancedTransactions(adapter.sent), false);
});
