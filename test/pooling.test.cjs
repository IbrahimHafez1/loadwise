'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');

const poolTypes = `
  export interface PoolClient { query(sql: string): Promise<{}>; release(): void }
  export class Pool { connect(): Promise<PoolClient>; query(sql: string): Promise<{}> }
`;
const files = {
  'node_modules/@types/pg/index.d.ts': poolTypes,
  'node_modules/mongodb/index.d.ts': 'export class MongoClient { constructor(uri: string) }',
  'node_modules/redis/index.d.ts': 'export function createClient(): {connect(): Promise<void>}',
  'node_modules/@prisma/client/index.d.ts': 'export class PrismaClient {}',
  'node_modules/@types/express/index.d.ts': 'export interface Router { get(path: string, handle: () => void): void }',
  'node_modules/fastify/index.d.ts': 'export interface FastifyInstance { post(path: string, options: {}, handle: () => void): void }',
};

test('detects package-verified pools and clients in a loop or an inline HTTP handler', () => {
  const findings = lint([
    "import { Pool as DatabasePool } from 'pg';",
    "import * as mongo from 'mongodb';",
    "import { createClient as openRedis } from 'redis';",
    "import { PrismaClient } from '@prisma/client';",
    "import { createServer as serve } from 'node:http';",
    "import * as https from 'node:https';",
    "import type { Router } from 'express';",
    "import type { FastifyInstance } from 'fastify';",
    "declare const router: Router, fastify: FastifyInstance;",
    "for (const id of [1,2]) { new DatabasePool(); }",
    "[1,2].map(id => new mongo.MongoClient('mongodb://localhost'));",
    "serve(() => { openRedis(); });",
    "https.createServer({}, () => new PrismaClient());",
    "router.get('/users', () => new DatabasePool());",
    "fastify.post('/users', {}, () => openRedis());",
  ].join('\n'), files);
  assert.deepEqual(findings.map(({ ruleId, line }) => [ruleId, line]),
    [10, 11, 12, 13, 14, 15].map(line => ['pool-created-per-request-or-item', line]));
});

test('persistent pools, lazy singletons, deferred functions and lookalikes stay quiet', () => {
  assert.deepEqual(lint(`
    import { Pool } from 'pg';
    import { createServer } from 'node:http';
    import { createClient } from 'redis';
    const pool = new Pool();
    function factory() { return new Pool(); }
    let shared: Pool | undefined;
    createServer(() => {
      shared ??= new Pool();
      if (!shared) shared = new Pool();
      const later = () => new Pool();
      pool.query('SELECT 1');
      function run(createClient: () => unknown) { [1,2].map(() => createClient()); }
    });
    function register(createServer: (callback: () => unknown) => void) {
      createServer(() => new Pool());
    }
    const custom = { get(path: string, callback: () => unknown) { return callback(); } };
    custom.get('/users', () => new Pool());
    function seed(Pool: new () => {}) { for (const id of [1,2]) new Pool(); }
  `, files), []);
});

test('detects lost direct pg checkouts and accepts released or independently managed clients', () => {
  const findings = lint([
    "import { Pool, type PoolClient } from 'pg';",
    "declare const pool: Pool, fake: {connect(): Promise<PoolClient>};",
    "async function run() {",
    "  await (await pool.connect()).query('SELECT 1');",
    "  (await (pool.connect()))!.query('BEGIN');",
    "  const client = await pool.connect();",
    "  try { await client.query('BEGIN'); await client.query('COMMIT'); } finally { client.release(); }",
    "  await pool.query('SELECT 1');",
    "  await (await fake.connect()).query('SELECT 1');",
    "}",
  ].join('\n'), files);
  assert.deepEqual(findings.map(({ ruleId, line }) => [ruleId, line]), [
    ['pg-unreleased-checkout', 4], ['pg-unreleased-checkout', 5],
  ]);
});

test('nullish guards around the shared pool assignment allocate once', () => {
  const findings = lint([
    "import { Pool } from 'pg';",
    "import { createServer } from 'node:http';",
    'let shared: Pool | null | undefined, other: Pool | undefined;',
    'createServer(() => {',
    '  if (shared == null) shared = new Pool();',
    '  if (null === shared) shared = new Pool();',
    '  if (shared === undefined) shared = new Pool();',
    '  if (shared !== null) shared = new Pool();',
    '  if (other == null) shared = new Pool();',
    '  let local: Pool | null = null; if (local === null) local = new Pool();',
    '  if (shared == null) { let shared: Pool; shared = new Pool(); }',
    '});',
  ].join('\n'), files);
  assert.deepEqual(findings.map(({ ruleId, line }) => [ruleId, line]),
    [8, 9, 10, 11].map(line => ['pool-created-per-request-or-item', line]));
});
