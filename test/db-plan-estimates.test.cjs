'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  filterColumns,
  seqScanCandidates,
  totalCost,
  planUsesIndex,
  describeQuery,
  planFinding,
  mysqlFullScans,
} = require('../lib/db/plan-estimates.cjs');

function tableModel(overrides = {}) {
  const orders = {
    schema: 'public',
    name: 'orders',
    rowEstimate: 2_400_000,
    columns: ['id', 'customer_id', 'status', 'created_at', 'email'],
    indexes: [{ name: 'orders_pkey', keys: [{ column: 'id' }], method: 'btree' }],
    ...overrides,
  };
  return new Map([['public.orders', orders]]);
}

function genericPlan(filter, extra = {}) {
  return [
    {
      Plan: {
        'Node Type': 'Limit',
        'Total Cost': 48_210.5,
        Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Filter: filter, 'Plan Rows': 12, ...extra }],
      },
    },
  ];
}

test('reads equality columns before range columns from a plan filter, skipping function-wrapped ones', () => {
  assert.deepEqual(filterColumns('((customer_id = $1) AND (created_at > $2))'), {
    equality: ['customer_id'],
    range: ['created_at'],
  });
  assert.deepEqual(filterColumns("((status)::text = 'paid'::text)"), { equality: ['status'], range: [] });
  assert.deepEqual(filterColumns('("customerId" = ANY ($1))'), { equality: ['customerId'], range: [] });
  assert.deepEqual(filterColumns("(lower(email) = 'a'::text)"), { equality: [], range: [] });
  assert.deepEqual(filterColumns('(total <> 0)'), { equality: [], range: [] });
});

test('a filtered seq scan on a large table yields an equality-then-range candidate', () => {
  const [candidate, ...rest] = seqScanCandidates(
    genericPlan('((created_at > $2) AND (customer_id = $1) AND (unknown_col = 1))'),
    tableModel(),
  );
  assert.deepEqual(rest, []);
  assert.deepEqual(candidate.columns, ['customer_id', 'created_at']);
  assert.equal(candidate.table.name, 'orders');
  assert.equal(totalCost(genericPlan('')), 48_210.5);
});

test('no candidate for small tables, unfiltered scans or columns that already lead an index', () => {
  assert.deepEqual(seqScanCandidates(genericPlan('(customer_id = $1)'), tableModel({ rowEstimate: 9_999 })), []);
  assert.deepEqual(seqScanCandidates(genericPlan(undefined), tableModel()), []);
  const indexed = tableModel({
    indexes: [{ name: 'orders_customer_idx', keys: [{ column: 'customer_id' }], method: 'btree' }],
  });
  assert.deepEqual(seqScanCandidates(genericPlan('(customer_id = $1)'), indexed), []);
  assert.deepEqual(
    seqScanCandidates(genericPlan('(customer_id = $1)', { 'Relation Name': 'other' }), tableModel()),
    [],
  );
});

test('finds an index by name anywhere in a plan and truncates long query text', () => {
  const plan = [
    { Plan: { 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Index Scan', 'Index Name': '<13>btree_orders' }] } },
  ];
  assert.equal(planUsesIndex(plan, '<13>btree_orders'), true);
  assert.equal(planUsesIndex(plan, 'other'), false);
  const long = describeQuery('SELECT\n  ' + 'x, '.repeat(200));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('...'));
});

test('without validation a candidate is a slow-plan finding with no impact numbers', () => {
  const [candidate] = seqScanCandidates(genericPlan('(customer_id = $1)'), tableModel());
  const finding = planFinding({
    subject: '`SELECT * FROM orders WHERE customer_id = $1` (1,204 calls, mean 41 ms measured by pg_stat_statements)',
    candidate,
    fix: 'CREATE INDEX CONCURRENTLY "orders_customer_id_idx" ON "public"."orders" ("customer_id");',
  });
  assert.equal(finding.ruleId, 'db-slow-query-plan');
  assert.equal(finding.target, 'public.orders');
  assert.equal(finding.impact, undefined);
  assert.match(finding.message, /about 2,400,000 rows, estimated\) filtering on `customer_id`\. Add `CREATE INDEX/);
});

test('a HypoPG-validated candidate is a missing-index finding with an estimated cost impact', () => {
  const [candidate] = seqScanCandidates(genericPlan('(customer_id = $1)'), tableModel());
  const finding = planFinding({
    subject: 'This query',
    location: { file: 'queries.sql', line: 3, column: 1 },
    candidate,
    fix: 'CREATE INDEX ...;',
    hypothetical: { before: 48_210.5, after: 8.44, used: true },
  });
  assert.equal(finding.ruleId, 'db-missing-index');
  assert.deepEqual(
    { file: finding.file, line: finding.line, target: finding.target },
    { file: 'queries.sql', line: 3, target: undefined },
  );
  assert.deepEqual(finding.impact, {
    kind: 'estimated',
    before: 48_211,
    after: 8,
    unit: 'planner cost',
    method: 'HypoPG hypothetical index, planner cost estimate',
  });
  assert.match(finding.message, /cost 48,211 -> 8, estimated by HypoPG/);
  const unused = planFinding({
    subject: 'This query',
    candidate,
    fix: 'X',
    hypothetical: { before: 5, after: 5, used: false },
  });
  assert.equal(unused.ruleId, 'db-slow-query-plan');
  assert.match(unused.message, /did not change the plan/);
});

test('MySQL full scans of large tables are read from nested FORMAT=JSON plans', () => {
  const model = tableModel();
  const plan = {
    query_block: {
      cost_info: { query_cost: '24120.50' },
      ordering_operation: {
        nested_loop: [
          { table: { table_name: 'orders', access_type: 'ALL', rows_examined_per_scan: 2_390_000 } },
          { table: { table_name: 'customers', access_type: 'eq_ref' } },
        ],
      },
    },
  };
  const { scans, queryCost } = mysqlFullScans(plan, model);
  assert.equal(queryCost, 24120.5);
  assert.deepEqual(
    scans.map((scan) => [scan.table.name, scan.rowsPerScan]),
    [['orders', 2_390_000]],
  );
  assert.deepEqual(mysqlFullScans(plan, tableModel({ rowEstimate: 50 })).scans, []);
});
