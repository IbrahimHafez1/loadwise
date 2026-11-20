'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const prismaFiles = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `
    export interface UserDelegate {
      findMany(options?: object): Promise<{ id: number }[]>;
      findFirst(options?: object): Promise<{ id: number } | null>;
      create(options: object): Promise<{ id: number }>;
      update(options: object): Promise<{ id: number }>;
      deleteMany(options?: object): Promise<{ count: number }>;
    }
    export declare class PrismaClient { user: UserDelegate }`,
};

const drizzleFiles = {
  'node_modules/drizzle-orm/pg-core/db.d.ts': `import {Query} from './query-builders/select';
export class Database {
  select(): {from(table: string): Query};
  update(table: string): {set(fields: object): Query};
  delete(table: string): Query;
}`,
  'node_modules/drizzle-orm/pg-core/query-builders/select.d.ts': `export class Query extends Promise<unknown[]> {
  where(predicate: unknown): Query;
  limit(size: number): Query;
}`,
};

const pgFiles = {
  'node_modules/@types/pg/index.d.ts': `
    interface PgResult { rows: { id: number }[], rowCount: number | null }
    export class Pool {
      query(input: string, values?: unknown[]): Promise<PgResult>;
    }
    export class ClientBase {
      query(input: string, values?: unknown[]): Promise<PgResult>;
    }
    export class Client extends ClientBase {}
    export interface PoolClient extends Client {}`,
};

function markedLines(source) {
  return source.split('\n').flatMap((line, index) => (line.endsWith('// report') ? [index + 1] : []));
}

function linesOf(source, files, ruleId) {
  return lint(source, files)
    .filter((finding) => finding.ruleId === ruleId)
    .map((finding) => finding.line);
}

test('Prisma drain, page and regenerate-until-unique loops depend on the previous result and are not per-item queries', () => {
  const source = `import type { PrismaClient } from '@prisma/client';
    declare const prisma: PrismaClient;
    declare const limit: number, count: number;
    async function drain() {
      for (;;) {
        const stale = await prisma.user.findMany({ where: { id: { lt: 5 } }, take: 100 });
        if (stale.length === 0) break;
        await prisma.user.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
      }
      let free = false;
      let candidate = 1;
      while (!free) {
        const taken = await prisma.user.findFirst({ where: { id: candidate } });
        if (taken) candidate += 1;
        else free = true;
      }
      const collected: { id: number }[] = [];
      for (let round = 0; round < limit && collected.length < count; round++) {
        const fetched = await prisma.user.findMany({ where: { id: { gt: collected.length } } });
        for (const row of fetched) collected.push(row);
      }
    }
    async function retry(attempts: number) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          return await prisma.user.create({ data: { id: Math.random() } });
        } catch {
          continue;
        }
      }
    }
    async function perItem(ids: number[], queue: number[]) {
      for (const id of ids) {
        try {
          await prisma.user.update({ where: { id }, data: {} }); // report
        } catch {
          continue;
        }
      }
      for (let index = 0; index < ids.length; index++) {
        try {
          await prisma.user.update({ where: { id: ids[index] }, data: {} }); // report
        } catch {
          continue;
        }
      }
      for (const id of ids) {
        const row = await prisma.user.findFirst({ where: { id } }); // report
        if (!row) break;
      }
      while (queue.length) {
        const id = queue.shift()!;
        const row = await prisma.user.update({ where: { id }, data: {} }); // report
        if (!row) break;
      }
      for (let index = 0; index < ids.length; index++) {
        const row = await prisma.user.findFirst({ where: { id: ids[index] } }); // report
        if (!row) break;
      }
      for (let attempt = 0; attempt < limit; attempt++) {
        await prisma.user.create({ data: { id: attempt } }); // report
      }
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        const row = await prisma.user.update({ where: { id }, data: {} }); // report
        if (!row) break;
      }
    }
    async function boundedDrain(maxPasses: number) {
      for (let pass = 0; pass < maxPasses; pass++) {
        const stale = await prisma.user.findMany({ where: { id: { lt: 5 } }, take: 100 });
        if (stale.length === 0) break;
        await prisma.user.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
      }
    }
    async function stationary() {
      for (;;) {
        const rows = await prisma.user.findMany({ where: { id: 10 }, take: 100 }); // report
        if (!rows.length) break;
      }
    }`;
  assert.deepEqual(linesOf(source, prismaFiles, 'prisma-query-in-loop'), markedLines(source));
});

test('Drizzle batch-delete and unique-code retry loops are sequential by design, per-row writes are not', () => {
  const source = `import type { Database } from 'drizzle-orm/pg-core/db';
    declare const db: Database;
    async function purge() {
      let removed: number;
      do {
        const result = await db.delete('sessions').where({ expired: true }).limit(500);
        removed = result.length;
      } while (removed > 0);
      let exists = true;
      let code = 'a';
      while (exists) {
        const [found] = await db.select().from('codes').where({ code });
        if (!found) exists = false;
        else code += 'a';
      }
    }
    async function perRow(ids: number[]) {
      for (const id of ids) {
        await db.update('users').set({ active: false }).where({ id }); // report
      }
      for (let index = 0; index < ids.length; index++) {
        await db.delete('users').where({ id: ids[index] }); // report
      }
    }`;
  assert.deepEqual(linesOf(source, drizzleFiles, 'drizzle-query-in-loop'), markedLines(source));
});

test('pg transaction, session, schema and diagnostic commands in a loop are not batchable per-item queries', () => {
  const source = `import type { PoolClient, Pool } from 'pg';
    declare const pool: Pool;
    async function measure(client: PoolClient, statement: string, runs: number, ids: number[]) {
      for (let run = 0; run < runs; run++) {
        await client.query('BEGIN');
        await client.query(\`EXPLAIN (ANALYZE, FORMAT JSON) \${statement}\`);
        await client.query('ROLLBACK');
        await client.query('SET statement_timeout = 0');
      }
      for (const id of ids) {
        await pool.query('DROP SCHEMA IF EXISTS tmp_' + id + ' CASCADE');
        await pool.query('UPDATE users SET active = false WHERE id = $1', [id]); // report
        await pool.query('SELECT * FROM users WHERE id = $1', [id]); // report
      }
    }`;
  assert.deepEqual(linesOf(source, pgFiles, 'pg-query-in-loop'), markedLines(source));
});

test('pg regenerate-until-free loop depends on the previous result', () => {
  const source = `import type { Pool } from 'pg';
    declare const pool: Pool;
    async function mint(ids: number[]) {
      let taken = true;
      let code = 0;
      while (taken) {
        const found = await pool.query('SELECT id FROM codes WHERE code = $1', [code]);
        taken = found.rows.length > 0;
        code += 1;
      }
      for (const id of ids) {
        const found = await pool.query('SELECT id FROM codes WHERE id = $1', [id]); // report
        taken = found.rows.length > 0;
      }
    }`;
  assert.deepEqual(linesOf(source, pgFiles, 'pg-query-in-loop'), markedLines(source));
});
