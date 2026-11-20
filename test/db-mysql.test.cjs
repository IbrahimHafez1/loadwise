'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createGateway, GatewayRefusal } = require('../lib/db/gateway.cjs');
const mysqlCatalog = require('../lib/db/mysql-catalog.cjs');
const { buildMysqlModel, mysqlCatalogFindings } = require('../lib/db/checks.cjs');
const { createRecordingAdapter, createSignals, unbalancedTransactions } = require('./db-fake-driver.cjs');

function setup(responses = {}) {
  const adapter = createRecordingAdapter({ engine: 'mysql', catalog: mysqlCatalog, responses });
  const signals = createSignals();
  return { adapter, signals, gateway: createGateway(adapter, { signals, exit: signals.exit, allowAnalyze: true }) };
}

test('MySQL sessions and units are read-only and rolled back', async () => {
  const { gateway, adapter } = setup({ tables: [{ table_name: 'orders' }] });
  await gateway.open();
  await gateway.catalog('tables');
  assert.deepEqual(
    adapter.sent.map(({ text }) => text),
    [
      'SET SESSION TRANSACTION READ ONLY',
      'SET SESSION max_execution_time = 5000',
      'START TRANSACTION READ ONLY',
      mysqlCatalog.statements.tables,
      'ROLLBACK',
    ],
  );
  assert.equal(unbalancedTransactions(adapter.sent), false);
});

test('MySQL EXPLAIN is one plain SELECT with FORMAT=JSON and never ANALYZE', async () => {
  const { gateway, adapter } = setup({ explain: [{ EXPLAIN: '{"query_block":{"cost_info":{"query_cost":"12.5"}}}' }] });
  const plan = await gateway.explain('SELECT * FROM orders WHERE customer_id = 7;');
  assert.equal(plan.query_block.cost_info.query_cost, '12.5');
  assert.ok(adapter.sent.some(({ text }) => text === 'EXPLAIN FORMAT=JSON SELECT * FROM orders WHERE customer_id = 7'));
  const before = adapter.sent.length;
  for (const sql of [
    'DELETE FROM orders',
    'SELECT 1; DROP TABLE orders',
    'SELECT 1 /*!50000 , SLEEP(10) */',
    'WITH x AS (SELECT 1) DELETE FROM orders',
  ]) {
    await assert.rejects(gateway.explain(sql), GatewayRefusal, sql);
  }
  await assert.rejects(gateway.explain('SELECT 1', { analyze: true }), /never run on MySQL/);
  assert.equal(adapter.sent.length, before);
});

test('MySQL unused and redundant indexes from the sys schema skip unique and primary keys', () => {
  const model = buildMysqlModel({
    tables: [{ schema_name: 'school', table_name: 'lessons', row_estimate: '120000', size_bytes: '1000' }],
    indexes: [
      {
        schema_name: 'school',
        table_name: 'lessons',
        index_name: 'PRIMARY',
        non_unique: 0,
        column_name: 'id',
        index_type: 'BTREE',
      },
      {
        schema_name: 'school',
        table_name: 'lessons',
        index_name: 'slug_key',
        non_unique: 0,
        column_name: 'slug',
        index_type: 'BTREE',
      },
      {
        schema_name: 'school',
        table_name: 'lessons',
        index_name: 'user_idx',
        non_unique: 1,
        column_name: 'user_id',
        index_type: 'BTREE',
      },
      {
        schema_name: 'school',
        table_name: 'lessons',
        index_name: 'user_updated_idx',
        non_unique: 1,
        column_name: 'user_id',
        index_type: 'BTREE',
      },
    ],
  });
  const findings = mysqlCatalogFindings(model, {
    uptimeDays: 40,
    unusedIndexes: [
      { schema_name: 'school', table_name: 'lessons', index_name: 'slug_key' },
      { schema_name: 'school', table_name: 'lessons', index_name: 'user_updated_idx' },
    ],
    redundantIndexes: [
      {
        schema_name: 'school',
        table_name: 'lessons',
        redundant_index_name: 'user_idx',
        redundant_index_columns: 'user_id',
        dominant_index_name: 'user_updated_idx',
        dominant_index_columns: 'user_id,last_updated',
      },
    ],
  });
  assert.deepEqual(
    findings.map((finding) => [finding.ruleId, finding.suggestion]),
    [
      ['db-unused-index', 'ALTER TABLE `lessons` DROP INDEX `user_updated_idx`, ALGORITHM=INPLACE, LOCK=NONE;'],
      ['db-duplicate-index', 'ALTER TABLE `lessons` DROP INDEX `user_idx`, ALGORITHM=INPLACE, LOCK=NONE;'],
    ],
  );
  assert.match(
    findings[0].message,
    /0 reads \(measured by performance_schema\) in the 40 days since the server started/,
  );
  const [young] = mysqlCatalogFindings(model, {
    uptimeDays: 1,
    unusedIndexes: [{ schema_name: 'school', table_name: 'lessons', index_name: 'user_idx' }],
  });
  assert.match(young.contextualReason, /run for 1 day, less than 7 days/);
});

test('MySQL foreign keys are grouped by constraint in column order for the snapshot', () => {
  const row = (column_name, referenced_column) => ({
    schema_name: 'school',
    table_name: 'enrolments',
    constraint_name: 'enrolments_course_fk',
    column_name,
    referenced_schema: 'school',
    referenced_table: 'courses',
    referenced_column,
  });
  const model = buildMysqlModel({
    tables: [{ schema_name: 'school', table_name: 'enrolments', row_estimate: 10, size_bytes: 1 }],
    foreignKeys: [row('course_id', 'id'), row('term', 'term')],
  });
  assert.deepEqual(model.get('school.enrolments').foreignKeys, [
    {
      name: 'enrolments_course_fk',
      columns: ['course_id', 'term'],
      references: { table: 'school.courses', columns: ['id', 'term'] },
    },
  ]);
});
