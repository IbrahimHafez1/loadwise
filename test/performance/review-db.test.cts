import assert from 'node:assert/strict';
import test from 'node:test';
import { createMongoGateway, inspectMongo } from '../../lib/performance/db/mongo.cjs';
import type { MongoAdapter, MongoCommand } from '../../lib/performance/types/db-connection.cjs';

const now = Date.parse('2026-11-20T00:00:00Z');

interface IndexSpec {
  name: string;
  key: Record<string, number>;
  collation?: { locale: string; strength: number };
  hidden?: boolean;
  sparse?: boolean;
}

interface FakeMongoReply {
  version?: string;
  was?: number;
  ok?: number;
  cursor?: { firstBatch: object[]; id: number };
}

function cursor(documents: readonly object[]): FakeMongoReply {
  return { cursor: { firstBatch: [...documents], id: 0 } };
}

function startsWithCollStats(document: MongoCommand): boolean {
  const { pipeline } = document;
  if (!Array.isArray(pipeline)) return false;
  const [firstStage] = pipeline;
  return (
    typeof firstStage === 'object' &&
    firstStage !== null &&
    '$collStats' in firstStage &&
    Boolean(firstStage.$collStats)
  );
}

function replyTo(document: MongoCommand, specs: readonly IndexSpec[]): FakeMongoReply {
  const name = Object.keys(document)[0];
  if (name === 'buildInfo') return { version: '8.0.4' };
  if (name === 'listCollections') return cursor([{ name: 'orders' }]);
  if (name === 'listIndexes') return cursor(specs);
  if (name === 'aggregate' && startsWithCollStats(document)) return cursor([{ storageStats: { count: 1 } }]);
  if (name === 'aggregate') return cursor(specs.map((spec) => ({ name: spec.name, accesses: { ops: 3 } })));
  if (name === 'profile') return { was: 0, ok: 1 };
  throw new Error('unexpected ' + name);
}

function fakeMongo(specs: readonly IndexSpec[]): MongoAdapter {
  return {
    engine: 'mongo',
    databaseName: 'shop',
    async command<Result>(document: MongoCommand): Promise<Result> {
      // The fake cannot know the caller's `Result`; the canned reply is trusted to match it.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- the fake cannot know the caller's Result type
      return replyTo(document, specs) as Result;
    },
    close: async () => {},
    destroy: async () => {},
  };
}

async function duplicateSuggestions(specs: readonly IndexSpec[]) {
  const { findings } = await inspectMongo(createMongoGateway(fakeMongo(specs)), { now });
  return findings.filter((finding) => finding.ruleId === 'db-duplicate-index').map((finding) => finding.suggestion);
}

test('Mongo: an index with another collation, a hidden one or a sparse one does not make a prefix redundant', async () => {
  const base: IndexSpec[] = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'sku_1', key: { sku: 1 } },
  ];
  const french = { locale: 'fr', strength: 2 };
  assert.deepEqual(await duplicateSuggestions([...base, { name: 'sku_fr', key: { sku: 1 }, collation: french }]), []);
  assert.deepEqual(
    await duplicateSuggestions([...base, { name: 'sku_1_qty_1', key: { sku: 1, qty: 1 }, collation: french }]),
    [],
  );
  assert.deepEqual(
    await duplicateSuggestions([...base, { name: 'sku_1_qty_1', key: { sku: 1, qty: 1 }, hidden: true }]),
    [],
  );
  assert.deepEqual(
    await duplicateSuggestions([...base, { name: 'sku_1_qty_1', key: { sku: 1, qty: 1 }, sparse: true }]),
    [],
  );
  assert.deepEqual(await duplicateSuggestions([...base, { name: 'sku_1_qty_1', key: { sku: 1, qty: 1 } }]), [
    'db.getCollection("orders").dropIndex("sku_1")',
  ]);
});
