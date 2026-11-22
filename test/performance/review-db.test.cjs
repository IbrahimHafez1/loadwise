'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMongoGateway, inspectMongo } = require('../../lib/performance/db/mongo.cjs');

const now = Date.parse('2026-11-20T00:00:00Z');

function cursor(documents) {
  return { cursor: { firstBatch: documents, id: 0 } };
}

function fakeMongo(specs) {
  return {
    databaseName: 'shop',
    async command(document) {
      const name = Object.keys(document)[0];
      if (name === 'buildInfo') return { version: '8.0.4' };
      if (name === 'listCollections') return cursor([{ name: 'orders' }]);
      if (name === 'listIndexes') return cursor(specs);
      if (name === 'aggregate' && document.pipeline[0].$collStats) return cursor([{ storageStats: { count: 1 } }]);
      if (name === 'aggregate') return cursor(specs.map((spec) => ({ name: spec.name, accesses: { ops: 3 } })));
      if (name === 'profile') return { was: 0, ok: 1 };
      throw new Error('unexpected ' + name);
    },
    close: async () => {},
    destroy: async () => {},
  };
}

async function duplicateSuggestions(specs) {
  const { findings } = await inspectMongo(createMongoGateway(fakeMongo(specs)), { now });
  return findings.filter((finding) => finding.ruleId === 'db-duplicate-index').map((finding) => finding.suggestion);
}

test('Mongo: an index with another collation, a hidden one or a sparse one does not make a prefix redundant', async () => {
  const base = [
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
