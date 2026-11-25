import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as model from '../../lib/performance/schema/model.js';
import { loadSnapshot, validateSnapshot, findProjectRoot } from '../../lib/performance/schema/context.js';
import type { TestContext } from 'node:test';

function ordersTable(dialect = 'postgres') {
  const table = model.createTable({ name: 'Order', dbName: 'orders', dialect, file: 'schema.prisma', line: 10 });
  for (const [name, dbName] of [
    ['id', 'id'],
    ['customerId', 'customer_id'],
    ['createdAt', 'created_at'],
    ['email', 'email'],
    ['name', 'name'],
    ['status', 'status'],
  ]) {
    table.columns.set(name, model.createColumn({ name, dbName, type: 'text' }));
  }
  table.indexes.push(
    model.createIndex({ keys: [{ column: 'id' }], unique: true, primary: true }),
    model.createIndex({ name: 'orders_user_created_idx', keys: [{ column: 'user_id' }, { column: 'created_at' }] }),
    model.createIndex({ keys: [{ column: 'status' }], predicate: "status = 'open'" }),
    model.createIndex({ keys: [{ column: 'email' }], method: 'hash' }),
    model.createIndex({ keys: [{ expression: 'LOWER("email")' }] }),
  );
  return table;
}

test('coverage distinguishes leading, non-leading and absent columns', () => {
  const table = ordersTable();
  assert.equal(model.coverage(table, 'id'), 'leading', 'primary key counts');
  assert.equal(model.coverage(table, 'createdAt'), 'non-leading', 'matched through the database name');
  assert.equal(model.coverage(table, 'customerId'), 'none');
  assert.equal(model.coverage(table, 'status'), 'none', 'a partial index is not assumed to apply');
  assert.equal(model.coverage(table, 'email'), 'none', 'a hash index cannot serve order or range');
  table.indexes.push(model.createIndex({ keys: [{ column: 'customer_id' }], unique: true }));
  assert.equal(model.coverage(table, 'customerId'), 'leading', 'unique constraints count');
});

test('patternIndex accepts trigram indexes and prefix-only pattern operator classes', () => {
  const table = ordersTable();
  assert.equal(model.patternIndex(table, 'name'), false);
  table.indexes.push(model.createIndex({ keys: [{ column: 'name', opclass: 'text_pattern_ops' }] }));
  assert.equal(model.patternIndex(table, 'name'), false, 'text_pattern_ops cannot serve a leading wildcard');
  assert.equal(model.patternIndex(table, 'name', { prefix: true }), true);
  table.indexes.push(model.createIndex({ keys: [{ column: 'name', opclass: 'gin_trgm_ops' }], method: 'gin' }));
  assert.equal(model.patternIndex(table, 'name'), true);
});

test('expressionIndex compares normalized expressions', () => {
  const table = ordersTable();
  assert.equal(model.expressionIndex(table, 'lower(email)'), true);
  assert.equal(model.expressionIndex(table, '(lower( "email" ))'), true);
  assert.equal(model.expressionIndex(table, 'upper(email)'), false);
  assert.equal(model.normalizeExpression('((created_at)::date)'), '(created_at)::date');
});

test('fixFor gives the source-specific suggestion and production DDL', () => {
  const table = ordersTable();
  const sql = 'CREATE INDEX CONCURRENTLY "orders_customer_id_idx" ON "orders" ("customer_id");';
  assert.deepEqual(model.fixFor(table, ['customerId'], 'prisma'), {
    suggestion: '@@index([customerId], map: "orders_customer_id_idx")',
    sql,
    name: 'orders_customer_id_idx',
  });
  assert.equal(
    model.fixFor(table, ['customerId'], 'drizzle').suggestion,
    "index('orders_customer_id_idx').on(table.customerId)",
  );
  assert.equal(
    model.fixFor(table, ['customerId'], 'typeorm').suggestion,
    "@Index('orders_customer_id_idx') on the property `customerId`",
  );
  assert.equal(
    model.fixFor(table, ['customerId', 'createdAt'], 'typeorm').suggestion,
    "@Index('orders_customer_id_created_at_idx', ['customerId', 'createdAt']) on the class",
  );
  assert.equal(
    model.fixFor(table, ['customerId'], 'sequelize').suggestion,
    "{ name: 'orders_customer_id_idx', fields: ['customerId'] } in `indexes`",
  );
  assert.equal(model.fixFor(table, ['customerId'], 'sql').suggestion, sql);
  assert.equal(
    model.fixFor(table, ['customerId', 'createdAt'], 'sql').sql,
    'CREATE INDEX CONCURRENTLY "orders_customer_id_created_at_idx" ON "orders" ("customer_id", "created_at");',
  );
  assert.equal(
    model.fixFor(ordersTable('mysql'), ['customerId'], 'sql').sql,
    'CREATE INDEX `orders_customer_id_idx` ON `orders` (`customer_id`) ALGORITHM=INPLACE LOCK=NONE;',
  );
  const mongo = model.fixFor(ordersTable('mongo'), ['customerId'], 'mongoose');
  assert.equal(mongo.suggestion, "orderSchema.index({ customerId: 1 }, { name: 'orders_customer_id_idx' })");
  assert.throws(() => model.fixFor(table, ['customerId'], 'hibernate'), /Unknown schema source/);
});

test('fixFor quotes schema-qualified names and bounds the generated index name', () => {
  const table = model.createTable({ name: 'Order', dbName: 'public.Order', dialect: 'postgres' });
  assert.equal(
    model.fixFor(table, ['createdAt'], 'sql').sql,
    'CREATE INDEX CONCURRENTLY "order_created_at_idx" ON "public"."Order" ("createdAt");',
  );
  const longName = model.fixFor(table, ['a'.repeat(80)], 'sql').sql;
  const indexName = /"([^"]+_idx)"/.exec(longName)?.[1];
  assert.ok(indexName !== undefined && indexName.length <= 63);
});

function writeSnapshot(context: TestContext, contents: string | object) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-snapshot-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'snapshot.json');
  fs.writeFileSync(filename, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return filename;
}

const validSnapshot = {
  version: 1,
  dialect: 'postgres',
  serverVersion: '18.1',
  capturedAt: '2026-11-18T10:00:00Z',
  roundTrip: { medianMs: 1.8, runs: 20, kind: 'measured', measuredFrom: 'cli-host' },
  statsAgeDays: 12,
  tables: { 'public.orders': { rowEstimate: 2400000, sizeBytes: 1, indexes: [{ keys: [{ column: 'id' }] }] } },
};

test('snapshots are validated on read and unknown versions are rejected', (context) => {
  assert.deepEqual(loadSnapshot(writeSnapshot(context, validSnapshot)), validSnapshot);
  assert.throws(() => validateSnapshot({ ...validSnapshot, version: 2 }), /Unsupported schema snapshot version/);
  assert.throws(() => validateSnapshot({ ...validSnapshot, dialect: 'oracle' }), /dialect/);
  assert.throws(() => validateSnapshot({ ...validSnapshot, roundTrip: { medianMs: -1 } }), /roundTrip/);
  assert.throws(
    () => validateSnapshot({ ...validSnapshot, tables: { orders: { rowEstimate: 'many' } } }),
    /rowEstimate/,
  );
  assert.throws(() => validateSnapshot({ ...validSnapshot, tables: { orders: { indexes: [{}] } } }), /keys/);
  const broken = writeSnapshot(context, '{"version":1, SECRET-SENTINEL');
  assert.throws(
    () => loadSnapshot(broken),
    (error) => error instanceof Error && /not valid JSON/.test(error.message) && !/SECRET-SENTINEL/.test(error.message),
  );
});

test('findProjectRoot walks up to the nearest package.json', () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  assert.equal(findProjectRoot(path.join(repository, 'lib', 'performance', 'schema')), repository);
  assert.equal(findProjectRoot(path.join(repository, 'lib', 'performance', 'analyze.cjs')), repository);
});

test('findProjectRoot does not climb out of the temp folder into a package.json above it', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-root-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  assert.equal(findProjectRoot(project), project);
});

test('fixFor names the index identically in every ORM suggestion and the DDL', () => {
  const table = ordersTable();
  const { name, sql } = model.fixFor(table, ['customerId'], 'sql');
  for (const orm of ['prisma', 'drizzle', 'typeorm', 'sequelize', 'mongoose']) {
    assert.ok(model.fixFor(table, ['customerId'], orm).suggestion.includes(name), orm);
  }
  assert.ok(sql.includes(`"${name}"`));
  const mongoDdl = model.fixFor(ordersTable('mongo'), ['customerId'], 'sql').sql;
  assert.equal(mongoDdl, `db.orders.createIndex({ customerId: 1 }, { name: '${name}' })`);
});
