import assert from 'node:assert/strict';
import test from 'node:test';
import type { MongoAdapter, MongoCommand } from '../../lib/performance/types/db-connection.cjs';
import { createMongoGateway, validateCommand, MongoRefusal, inspectMongo } from '../../lib/performance/db/mongo.cjs';

const day = 86_400_000;
const now = Date.parse('2026-11-20T00:00:00Z');

function cursor(documents: readonly object[]) {
  return { cursor: { firstBatch: documents, id: 0 } };
}

function isCollStatsPipeline(document: MongoCommand): boolean {
  const { pipeline } = document;
  if (!Array.isArray(pipeline)) return false;
  const firstStage: unknown = pipeline[0];
  return typeof firstStage === 'object' && firstStage !== null && '$collStats' in firstStage;
}

function fakeMongo({ profileLevel = 0, indexAgeDays = 30 } = {}) {
  const sent: MongoCommand[] = [];
  const specs = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'customer_1', key: { customerId: 1 } },
    { name: 'customer_1_createdAt_-1', key: { customerId: 1, createdAt: -1 } },
    { name: 'email_1', key: { email: 1 }, unique: true },
    { name: 'expires_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    { name: 'status_1', key: { status: 1 } },
  ];
  const since = new Date(now - indexAgeDays * day);
  const accesses: Record<string, number> = {
    _id_: 9,
    customer_1: 4,
    'customer_1_createdAt_-1': 40,
    email_1: 0,
    expires_1: 0,
    status_1: 0,
  };
  function reply<Result>(document: MongoCommand): Result;
  function reply(document: MongoCommand): unknown {
    const name = Object.keys(document)[0];
    if (name === 'buildInfo') return { version: '8.0.4' };
    if (name === 'listCollections') return cursor([{ name: 'orders' }, { name: 'system.views' }]);
    if (name === 'listIndexes') return cursor(specs);
    if (name === 'aggregate' && isCollStatsPipeline(document)) {
      return cursor([{ storageStats: { count: 52000, size: 9_000_000 } }]);
    }
    if (name === 'aggregate')
      return cursor(specs.map((spec) => ({ name: spec.name, accesses: { ops: accesses[spec.name], since } })));
    if (name === 'profile') return { was: profileLevel, ok: 1 };
    if (name === 'find') {
      return cursor([
        { ns: 'shop.orders', docsExamined: 52000, nreturned: 3 },
        { ns: 'shop.orders', docsExamined: 51000, nreturned: 1 },
      ]);
    }
    throw new Error('unexpected ' + name);
  }
  const adapter: MongoAdapter = {
    engine: 'mongo',
    databaseName: 'shop',
    async command<Result>(document: MongoCommand): Promise<Result> {
      sent.push(document);
      return reply<Result>(document);
    },
    close: async () => {},
    destroy: async () => {},
  };
  return { adapter, sent };
}

test('only allowlisted, read-level MongoDB commands pass', () => {
  for (const allowed of [
    { ping: 1 },
    { buildInfo: 1 },
    { listCollections: 1, nameOnly: true },
    { listIndexes: 'orders', cursor: {} },
    { aggregate: 'orders', pipeline: [{ $indexStats: {} }], cursor: {}, maxTimeMS: 5000 },
    { aggregate: 'orders', pipeline: [{ $collStats: { storageStats: {} } }], cursor: {} },
    { find: 'system.profile', filter: { planSummary: 'COLLSCAN' }, limit: 5 },
    { profile: -1 },
    { explain: { find: 'orders', filter: {} }, verbosity: 'queryPlanner' },
  ]) {
    assert.doesNotThrow(() => validateCommand(allowed), JSON.stringify(allowed));
  }
  for (const refused of [
    { profile: 1 },
    { profile: 0 },
    { profile: -1, slowms: 1 },
    { aggregate: 'orders', pipeline: [{ $match: {} }], cursor: {} },
    { aggregate: 'orders', pipeline: [{ $indexStats: {} }, { $out: 'copy' }], cursor: {} },
    { find: 'orders', filter: {} },
    { explain: { find: 'orders' }, verbosity: 'executionStats' },
    { explain: { delete: 'orders', deletes: [] }, verbosity: 'queryPlanner' },
    { dropIndexes: 'orders', index: '*' },
    { createIndexes: 'orders', indexes: [] },
    { ping: 1, comment: { $where: 'x' } },
  ]) {
    assert.throws(() => validateCommand(refused), MongoRefusal, JSON.stringify(refused));
  }
});

test('the gateway refuses before calling the driver', async () => {
  const { adapter, sent } = fakeMongo();
  const gateway = createMongoGateway(adapter);
  await assert.rejects(gateway.command({ profile: 2 }), MongoRefusal);
  assert.deepEqual(sent, []);
});

test('reports unused and prefix-duplicate indexes but never _id, unique or TTL indexes', async () => {
  const { adapter } = fakeMongo();
  const result = await inspectMongo(createMongoGateway(adapter), { now });
  assert.equal(result.serverVersion, '8.0.4');
  assert.deepEqual(
    result.findings.map((finding) => [finding.ruleId, finding.suggestion]),
    [
      ['db-unused-index', 'db.getCollection("orders").dropIndex("status_1")'],
      ['db-duplicate-index', 'db.getCollection("orders").dropIndex("customer_1")'],
    ],
  );
  assert.match(result.findings[0].message, /0 accesses \(measured by \$indexStats\) in the 30 days/);
  assert.equal(result.findings[0].target, 'shop.orders');
  assert.deepEqual(Object.keys(result.tables), ['shop.orders']);
  assert.equal(result.tables['shop.orders'].rowEstimate, 52000);
  assert.ok(result.notes.some((note) => /profiler is off; `db` never enables it/.test(note)));
});

test('young index statistics make unused indexes contextual', async () => {
  const { adapter } = fakeMongo({ indexAgeDays: 2 });
  const [unused] = (await inspectMongo(createMongoGateway(adapter), { now })).findings;
  assert.ok(unused.contextualReason);
  assert.match(unused.contextualReason, /less than 7 days/);
});

test('reads COLLSCAN operations only when the profiler is already on, and never sets its level', async () => {
  const { adapter, sent } = fakeMongo({ profileLevel: 1 });
  const result = await inspectMongo(createMongoGateway(adapter), { now });
  const scan = result.findings.find((finding) => finding.ruleId === 'mongo-collection-scan-observed');
  assert.ok(scan);
  assert.match(scan.message, /2 profiled operations on `shop\.orders` scanned the whole collection/);
  assert.match(scan.message, /up to 52,000 documents \(measured\)/);
  assert.deepEqual(
    sent.filter((document) => 'profile' in document),
    [{ profile: -1 }],
  );
});
