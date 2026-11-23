'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const helpers = require('./helpers.cjs');

// These fixtures use `SELECT *` freely; sql-select-star-in-query has its own tests, so the expectations here stay
// exact for the pg rules.
const lint = (...args) => helpers.lint(...args).filter((finding) => finding.ruleId !== 'sql-select-star-in-query');

const pgTypes = `
  interface PgResult { rows: { id: number, active: boolean, label: string }[] }
  type QueryInput = string | { text: string, values?: unknown[] };
  export class Pool {
    query(input: QueryInput, values?: unknown[]): Promise<PgResult>;
    connect(): Promise<PoolClient>;
  }
  export class ClientBase {
    query<Query extends { submit(connection: unknown): void }>(input: Query): Query;
    query(input: QueryInput, values?: unknown[]): Promise<PgResult>;
  }
  export class Client extends ClientBase {}
  export interface PoolClient extends Client {}
`;
const pgFiles = { 'node_modules/@types/pg/index.d.ts': pgTypes };

test('discarded reads of PostgreSQL results do not suggest pushing the unused work into SQL', () => {
  assert.deepEqual(
    lint(
      `import type { Pool } from 'pg';
    async function run(pool: Pool) {
      void (0, (await pool.query('SELECT * FROM items')).rows.length);
      void (await pool.query('SELECT * FROM items')).rows[0];
      (await pool.query('SELECT * FROM items')).rows.sort((a, b) => b.id - a.id).slice(0, 3);
    }`,
      pgFiles,
    ),
    [],
  );
});

test('pg catches repeated reads, writes and query configs on typed clients', () => {
  const findings = lint(
    `import { Pool as DatabasePool, type Client, type PoolClient } from 'pg';
const pool = new DatabasePool();
async function load(ids: number[], client: Client, checkedOut: PoolClient, sql: string) {
  for (const id of ids) await pool.query('SELECT * FROM accounts WHERE id = $1', [id]);
  await Promise.all(ids.map(id => client.query({ text: sql, values: [id] })));
  for (const id of ids) await checkedOut.query('DELETE FROM staged WHERE id = $1', [id]);
  const connection = await pool.connect();
  for (const id of ids) await connection.query(sql, [id]);
}`,
    pgFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['pg-query-in-loop', 4],
      ['pg-query-in-loop', 5],
      ['pg-query-in-loop', 6],
      ['pg-query-in-loop', 8],
    ],
  );
});

test('pg avoids batched reads and unrelated clients with identical names', () => {
  const findings = lint(
    `import { Pool } from 'pg';
import { Pool as SearchPool } from 'local-search';
const pool = new Pool();
async function load(ids: number[], fake: { query(id: number): { rows: number[] } }) {
  const results = await pool.query('SELECT * FROM accounts WHERE id = ANY($1)', [ids]);
  for (const row of results.rows) console.log(row);
  for (const id of ids) fake.query(id);
  const search = new SearchPool();
  for (const id of ids) await search.query('example', [id]);
  return (await fake.query(1)).rows.length;
}`,
    { ...pgFiles, 'node_modules/local-search/index.d.ts': pgTypes },
  );
  assert.deepEqual(findings, []);
});

test('pg suggests counting in SQL for a simple literal SELECT used only for its length', () => {
  const findings = lint(
    `import { Pool } from 'pg';
const pool = new Pool();
async function count(active: boolean) {
  const total = (await pool.query('SELECT id, name FROM public.accounts WHERE active = $1;', [active])).rows.length;
  return total + (await pool.query({ text: 'SELECT * FROM accounts' }))!.rows.length;
}`,
    pgFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['pg-count-materialization', 4],
      ['pg-count-materialization', 5],
    ],
  );
});

test('pg skips ambiguous or bounded count expressions and rows used elsewhere', () => {
  const findings = lint(
    `import { Pool } from 'pg';
const pool = new Pool();
async function inspect(sql: string) {
  const dynamic = (await pool.query(sql)).rows.length;
  const bounded = (await pool.query('SELECT * FROM accounts LIMIT 10')).rows.length;
  const locked = (await pool.query('SELECT * FROM accounts FOR UPDATE')).rows.length;
  const writing = (await pool.query('DELETE FROM accounts RETURNING id')).rows.length;
  const aggregate = (await pool.query('SELECT count(*) FROM accounts')).rows.length;
  const discarded = ((await pool.query('SELECT * FROM accounts')).rows.length, true);
  const configured = (await pool.query({ text: 'SELECT * FROM accounts', ...{ text: sql } })).rows.length;
  const result = await pool.query('SELECT * FROM accounts');
  const indirect = ((await pool.query('SELECT * FROM accounts')), { rows: [1] }).rows.length;
  (await pool.query('SELECT * FROM accounts')).rows.length = 0;
  return { total: result.rows.length, rows: result.rows };
}`,
    pgFiles,
  );
  assert.deepEqual(findings, []);
});

test('pg keeps quoted SQL, shadowed clients, custom submissions and destructuring writes out of row counts', () => {
  const findings = lint(
    `import type { Client } from 'pg';
declare function submit(connection: unknown): void;
async function inspect(client: Client) {
  const quoted = (await client.query("SELECT 'SELECT * FROM users' AS sample")).rows.length;
  const commented = (await client.query('/* SELECT * FROM users */ SELECT count(*) FROM users')).rows.length;
  const bounded = (await client.query('SELECT * FROM users /* SELECT * FROM users */ LIMIT 3')).rows.length;
  const custom = (await client.query({ text: 'SELECT * FROM users', rows: [1], submit })).rows.length;
  ({ count: (await client.query('SELECT * FROM users')).rows.length } = { count: 1 });
  {
    const client = { query: async (text: string) => ({ rows: [text] }) };
    const shadowed = (await client.query('SELECT * FROM users')).rows.length;
  }
  return { count: (await client.query('SELECT * FROM users')).rows.length };
}`,
    pgFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [['pg-count-materialization', 13]],
  );
});

test('pg detects unbounded first-row reads and skips bounded queries and writes', () => {
  const findings = lint(
    `import { Pool } from 'pg';
const db = new Pool();
async function first(active: boolean, sql: string, fake: { query(text: string): Promise<{rows: unknown[]}> }) {
  const ordered = (await db.query('SELECT id, name FROM app.users WHERE active = $1 ORDER BY name ASC, id DESC NULLS LAST;', [active])).rows[0];
  const anyRow = (await db.query({text: 'SELECT * FROM users'})).rows[0];
  const limited = (await db.query('SELECT * FROM users ORDER BY id LIMIT 1')).rows[0];
  const complex = (await db.query('SELECT * FROM users ORDER BY random()')).rows[0];
  const locked = (await db.query('SELECT * FROM users FOR UPDATE')).rows[0];
  const dynamic = (await db.query(sql)).rows[0];
  const second = (await db.query('SELECT * FROM users')).rows[1];
  const lookalike = (await fake.query('SELECT * FROM users')).rows[0];
  (await db.query('SELECT * FROM users')).rows[0] = undefined;
  delete (await db.query('SELECT * FROM users')).rows[0];
  const result = await db.query('SELECT * FROM users');
  return {ordered, anyRow, result, first: result.rows[0]};
}`,
    pgFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['pg-first-materialization', 4],
      ['pg-first-materialization', 5],
    ],
  );
  assert.match(findings[0].message, /LIMIT 1/);
  assert.match(findings[0].message, /order/i);
});

test('pg recognizes simple local filtering and bounded numeric sort consumers', () => {
  const findings = lint(
    `import { Pool } from 'pg';
const db = new Pool();
async function example(threshold: number, dynamic: string) {
  const active = (await db.query('SELECT id, active FROM users')).rows.filter(row => row.active === true);
  const labeled = (await db.query({text: 'SELECT * FROM users WHERE id > $1', values: [0]})).rows.filter(row => 'A' === row.label);
  const top = (await db.query('SELECT id FROM users ORDER BY label')).rows.sort((left, right) => right.id - left.id).slice(0, 3);
  const minimum = (await db.query('SELECT * FROM users')).rows.sort((left, right) => left.id - right.id)[0];
  const filteredInDb = (await db.query('SELECT id FROM users WHERE active = $1', [true])).rows;
  const limited = (await db.query('SELECT * FROM users ORDER BY id LIMIT 3')).rows.sort((left, right) => left.id - right.id)[0];
  const notSelected = (await db.query('SELECT label FROM users')).rows.filter(row => row.active === false);
  const fromVariable = (await db.query(dynamic)).rows.filter(row => row.active === false);
  const arbitrary = (await db.query('SELECT * FROM users')).rows.filter(row => row.id > threshold);
  const expression = (await db.query('SELECT * FROM users')).rows.filter(row => row.label.toLowerCase() === 'a');
  const dynamicLimit = (await db.query('SELECT * FROM users')).rows.sort((a,b) => a.id - b.id).slice(0,threshold);
  const reassigned = (await db.query('SELECT * FROM users')).rows.sort((a,b) => a.id - b.id)[0] = active[0];
  const fullSort = (await db.query('SELECT * FROM users')).rows.sort((a,b) => a.id - b.id);
}`,
    pgFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['pg-filter-materialization', 4],
      ['pg-filter-materialization', 5],
      ['pg-top-k-materialization', 6],
      ['pg-top-k-materialization', 7],
    ],
  );
});

test('a migration runner applying raw SQL items in order is not a batchable query loop', () => {
  const findings = lint(
    `import type { PoolClient } from 'pg';
async function migrate(client: PoolClient, migrations: { sql: string[]; hash: string }[]) {
  for (const migration of migrations) {
    for (const statement of migration.sql) {
      await client.query(statement);
    }
    await client.query('INSERT INTO journal(hash) VALUES($1)', [migration.hash]);
  }
}`,
    pgFiles,
  );
  assert.deepEqual(findings, []);
});

test('queries that merely use loop values as parameters stay reported next to raw SQL items', () => {
  const findings = lint(
    `import type { PoolClient } from 'pg';
async function load(client: PoolClient, ids: number[], statements: string[]) {
  for (const id of ids) {
    await client.query('SELECT * FROM accounts WHERE id = $1', [id]);
  }
  for (const statement of statements) {
    await client.query(statement);
  }
  for (const id of ids) {
    await client.query('SELECT * FROM items WHERE id = $1', [id]);
  }
}`,
    pgFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['pg-query-in-loop', 4],
      ['pg-query-in-loop', 10],
    ],
  );
});
