'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPostgresModel, postgresCatalogFindings, sizeGateRows } = require('../../lib/performance/db/checks.cjs');

function table(name, extra = {}) {
  return {
    schema_name: 'public',
    table_name: name,
    row_estimate: '50000',
    size_bytes: '8192000',
    seq_scan: '2',
    seq_tup_read: '100',
    idx_scan: '500',
    n_live_tup: '50000',
    ...extra,
  };
}

function index(tableName, name, columns, extra = {}) {
  return {
    schema_name: 'public',
    table_name: tableName,
    index_name: name,
    method: 'btree',
    is_unique: false,
    is_primary: false,
    backs_constraint: false,
    predicate: null,
    key_columns: columns,
    key_definitions: columns,
    key_opclasses: columns.map(() => 'int4_ops'),
    key_descending: columns.map(() => false),
    idx_scan: '40',
    size_bytes: '1048576',
    ...extra,
  };
}

function foreignKey(tableName, name, columns, referenced = 'customers') {
  return {
    schema_name: 'public',
    table_name: tableName,
    constraint_name: name,
    columns,
    referenced_schema: 'public',
    referenced_table: referenced,
    referenced_columns: ['id'],
  };
}

function findingsFor(catalog, options = { statsAgeDays: 30 }) {
  return postgresCatalogFindings(buildPostgresModel(catalog), options);
}

function byRule(findings, ruleId) {
  return findings.filter((finding) => finding.ruleId === ruleId);
}

test('an FK with no index starting with its columns is reported with the CREATE INDEX fix', () => {
  const findings = byRule(
    findingsFor({
      tables: [table('orders'), table('customers')],
      indexes: [index('orders', 'orders_pkey', ['id'], { is_primary: true, is_unique: true, backs_constraint: true })],
      foreignKeys: [foreignKey('orders', 'orders_customer_id_fkey', ['customer_id'])],
    }),
    'db-unindexed-foreign-key',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].target, 'public.orders');
  assert.equal(
    findings[0].suggestion,
    'CREATE INDEX CONCURRENTLY "orders_customer_id_idx" ON "public"."orders" ("customer_id");',
  );
  assert.match(findings[0].message, /about 50,000 rows \(estimated from planner statistics\)/);
  assert.equal(findings[0].contextualReason, undefined);
});

test('an FK is covered by a btree index leading with its columns in any order, not by a partial or later one', () => {
  const base = {
    tables: [table('orders')],
    foreignKeys: [foreignKey('orders', 'orders_tenant_customer_fkey', ['tenant_id', 'customer_id'])],
  };
  const covered = findingsFor({
    ...base,
    indexes: [index('orders', 'by_customer_tenant', ['customer_id', 'tenant_id', 'id'])],
  });
  assert.deepEqual(byRule(covered, 'db-unindexed-foreign-key'), []);
  for (const uncovering of [
    index('orders', 'later', ['id', 'tenant_id', 'customer_id']),
    index('orders', 'partial', ['tenant_id', 'customer_id'], { predicate: '(deleted_at IS NULL)' }),
    index('orders', 'hash', ['tenant_id'], { method: 'hash' }),
  ]) {
    assert.equal(byRule(findingsFor({ ...base, indexes: [uncovering] }), 'db-unindexed-foreign-key').length, 1);
  }
});

test('an FK on a small table is contextual, with the size gate in the reason', () => {
  const [finding] = findingsFor({
    tables: [table('orders', { row_estimate: String(sizeGateRows - 1) })],
    foreignKeys: [foreignKey('orders', 'fk', ['customer_id'])],
  });
  assert.match(finding.contextualReason, /9,999 rows \(estimated\), below the 10,000-row threshold/);
});

test('unused indexes exclude primary, unique and constraint-backing ones and need a week of statistics', () => {
  const catalog = {
    tables: [table('orders')],
    indexes: [
      index('orders', 'orders_pkey', ['id'], {
        is_primary: true,
        is_unique: true,
        backs_constraint: true,
        idx_scan: '0',
      }),
      index('orders', 'orders_code_key', ['code'], { is_unique: true, idx_scan: '0' }),
      index('orders', 'orders_status_idx', ['status'], { idx_scan: '0' }),
      index('orders', 'orders_total_idx', ['total'], { idx_scan: '12' }),
    ],
  };
  const [finding, ...rest] = byRule(findingsFor(catalog), 'db-unused-index');
  assert.deepEqual(rest, []);
  assert.match(finding.message, /`orders_status_idx` on `orders` was scanned 0 times \(measured\) in the 30 days/);
  assert.match(finding.message, /replicas keep their own counters/);
  assert.match(finding.message, /1\.0 MB \(measured\)/);
  assert.equal(finding.suggestion, 'DROP INDEX CONCURRENTLY "public"."orders_status_idx";');
  assert.equal(finding.contextualReason, undefined);
  const [young] = byRule(findingsFor(catalog, { statsAgeDays: 2.5 }), 'db-unused-index');
  assert.match(young.contextualReason, /cover 2 days, less than 7 days/);
});

test('duplicate indexes: identical keys keep the constraint-backing one, a btree prefix drops the shorter', () => {
  const findings = byRule(
    findingsFor({
      tables: [table('orders')],
      indexes: [
        index('orders', 'orders_status_idx', ['status']),
        index('orders', 'orders_status_total_idx', ['status', 'total']),
        index('orders', 'orders_code_key', ['code'], { is_unique: true, backs_constraint: true }),
        index('orders', 'orders_code_idx', ['code']),
        index('orders', 'orders_total_desc', ['total'], { key_descending: [true] }),
        index('orders', 'orders_total_asc', ['total', 'id']),
        index('orders', 'orders_status_partial', ['status'], { predicate: '(total > 0)' }),
      ],
    }),
    'db-duplicate-index',
  );
  assert.deepEqual(
    findings.map((finding) => finding.suggestion),
    ['DROP INDEX CONCURRENTLY "public"."orders_status_idx";', 'DROP INDEX CONCURRENTLY "public"."orders_code_idx";'],
  );
  assert.match(findings[0].message, /is a leading prefix of `orders_status_total_idx` \(`status`, `total`\)/);
  assert.match(findings[1].message, /has the same keys as `orders_code_key`/);
});

test('a unique index that is a prefix of a wider index is not a duplicate', () => {
  const findings = findingsFor({
    tables: [table('orders')],
    indexes: [index('orders', 'one', ['code'], { is_unique: true }), index('orders', 'two', ['code', 'id'])],
  });
  assert.deepEqual(byRule(findings, 'db-duplicate-index'), []);
});

test('retains covering, differently sorted or collated, protected, and unavailable indexes', () => {
  const base = index('orders', 'plain', ['code'], { key_semantics: ['42:100:0'] });
  for (const extra of [
    { duplicate_comparable: false },
    { key_semantics: ['42:200:0'] },
    { key_semantics: ['42:100:2'] },
    { key_semantics: ['71:100:0'] },
    { is_usable: false },
  ]) {
    const alternate = { ...base, ...extra, index_name: 'alternate' };
    for (const indexes of [
      [base, alternate],
      [alternate, base],
    ]) {
      const findings = findingsFor({ tables: [table('orders')], indexes });
      assert.deepEqual(byRule(findings, 'db-duplicate-index'), []);
    }
  }
  const protectedIndex = { ...base, index_name: 'replica_identity', is_protected: true, idx_scan: '0' };
  const findings = findingsFor({ tables: [table('orders')], indexes: [base, protectedIndex] });
  assert.ok(findings.every(({ suggestion }) => !suggestion?.includes('"replica_identity"')));
});

test('seq-scan-heavy tables need size, more seq than index scans and repeated full reads', () => {
  const heavy = table('events', { seq_scan: '1204', seq_tup_read: '48160000', idx_scan: '3', n_live_tup: '40000' });
  const [finding] = byRule(findingsFor({ tables: [heavy] }), 'db-seq-scan-heavy-table');
  assert.match(
    finding.message,
    /1,204 sequential scans reading 48,160,000 rows against 3 index scans in the 30 days since statistics were reset \(measured counters\)/,
  );
  assert.match(finding.message, /about 40,000 live rows \(estimated\)/);
  for (const quiet of [
    { ...heavy, n_live_tup: '9000', seq_tup_read: '9000000' },
    { ...heavy, idx_scan: '5000' },
    { ...heavy, seq_tup_read: '100000' },
  ]) {
    assert.deepEqual(byRule(findingsFor({ tables: [quiet] }), 'db-seq-scan-heavy-table'), []);
  }
});

test('reltuples of -1 falls back to the live-tuple estimate', () => {
  const model = buildPostgresModel({ tables: [table('fresh', { row_estimate: '-1', n_live_tup: '12' })] });
  assert.equal(model.get('public.fresh').rowEstimate, 12);
});

test('periods read naturally for unknown, sub-day and multi-day statistics', () => {
  const { sinceEvent } = require('../../lib/performance/db/checks.cjs');
  assert.equal(sinceEvent(undefined, 'statistics were reset'), 'since statistics were reset');
  assert.equal(sinceEvent(0.2, 'statistics were reset'), 'since statistics were reset less than a day ago');
  assert.equal(sinceEvent(1.5, 'the server started'), 'in the 1 day since the server started');
});
