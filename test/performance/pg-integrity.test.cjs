'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');

const declarations = `type Input = string | {text: string, values?: unknown[]};
export class Pool {
  query(statement: Input, values?: unknown[]): Promise<unknown>;
  connect(): Promise<PoolClient>;
}
export class Client {query(statement: Input, values?: unknown[]): Promise<unknown>}
export interface PoolClient extends Client {release(): void}`;
const files = { 'node_modules/@types/pg/index.d.ts': declarations };

test('standalone transaction commands require a checked-out PostgreSQL client', () => {
  const findings = lint(
    `import {Pool as DatabasePool, type Client} from 'pg';
async function work(pool: DatabasePool, client: Client) {
  await pool.query('BEGIN');
  await pool.query({text: 'start transaction READ ONLY, ISOLATION LEVEL SERIALIZABLE;'});
  await pool['query']('SAVEPOINT part_one');
  await pool.query('ROLLBACK TRANSACTION TO SAVEPOINT part_one');
  await pool.query({['text']: 'release savepoint part_one'});
  await pool.query('SET TRANSACTION READ WRITE');
  await pool.query('commit and no chain; -- final step');
  await pool.query('/* maintenance */ ROLLBACK;');
  const connection = await pool.connect();
  try {await connection.query('BEGIN'); await connection.query('COMMIT');} finally {connection.release();}
  await client.query('ROLLBACK');
  await pool.query("SELECT 'BEGIN' AS label");
  await pool.query('BEGIN; SELECT 1; COMMIT');
  await pool.query("COMMIT PREPARED 'task'");
  await pool.query('SELECT 1 -- COMMIT');
}`,
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [3, 4, 5, 6, 7, 8, 9, 10].map((line) => ['pg-transaction-on-pool', line]),
  );
});

test('a pool cannot own a transaction even when the complete command is assembled from constants', () => {
  const findings = lint(
    [
      "import type {Pool, Client} from 'pg';",
      "import {begin} from './commands';",
      'declare const pool: Pool, client: Client, input: string, flag: boolean;',
      "const suffix = '';",
      'pool.query(`${begin}`);',
      "pool.query('BE' + 'GIN');",
      'pool.query(`BEGIN${suffix}`);',
      'pool.query({text: begin});',
      'const join = (one: string, two: string) => one + two;',
      "pool.query(`${join('ROLL', 'BACK')}`);",
      'client.query(`${begin}`);',
      'pool.query(`${begin}; SELECT 1; COMMIT`);',
      'pool.query(`SELECT ${1 + 2}`);',
      "pool.query(`${flag ? 'BEGIN' : 'SELECT 1'}`);",
      'pool.query(`BEGIN ${input}`);',
      'declare const other: {query(sql: string): void};',
      'other.query(begin);',
    ].join('\n'),
    { ...files, 'commands.ts': "export const begin = 'BEGIN';" },
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [5, 6, 7, 8, 10].map((line) => ['pg-transaction-on-pool', line]),
  );
});

test('query configuration follows last-property precedence and custom query implementations stay clean', () => {
  const findings = lint(
    `import type {Pool} from 'pg';
async function run(pool: Pool, table: string, options: {text: string}, optionName: string, fake: {query(text:string): void}) {
  await pool.query({...options, text: 'BEGIN'});
  await pool.query({text: 'BEGIN', ...options});
  await pool.query({...options, text: 'SELECT id FROM ' + table});
  await pool.query({text: 'SELECT id FROM ' + table, [optionName]: 'SELECT 1'});
  await pool.query({text: 'BEGIN', ['text']: 'SELECT 1'});
  fake.query('BEGIN');
  fake.query(\`SELECT id FROM \${table}\`);
  await pool.query({text: 'BEGIN'});
  await pool.query({['text']: 'SELECT id FROM ' + table});
}`,
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [['pg-transaction-on-pool', 10]],
  );
});

test('custom Submittables, prototypes and opaque properties on either side of text are outside the pg text contract', () => {
  const findings = lint(
    `import type {Pool} from 'pg';
async function review(pool: Pool, table: string, key: string, submit: () => void) {
  const custom = {submit};
  await pool.query({text: 'BEGIN', submit});
  await pool.query({['submit']: submit, text: 'BEGIN'});
  await pool.query({text: 'SELECT id FROM ' + table, submit() {}});
  await pool.query({__proto__: custom, text: 'BEGIN'});
  await pool.query({text: 'BEGIN', __proto__: custom});
  await pool.query({...custom, text: 'BEGIN'});
  await pool.query({text: 'SELECT id FROM ' + table, ...custom});
  await pool.query({[key]: submit, text: 'BEGIN'});
  await pool.query({text: 'BEGIN', [key]: submit});
  await pool.query({name: 'scope-check', text: 'BEGIN', values: []});
}`,
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [['pg-transaction-on-pool', 13]],
  );
});

test('transaction control requires an overload declared by pg and skips an overriding subclass', () => {
  const findings = lint(
    `import {Pool as DriverPool} from 'pg';
declare module 'pg' { interface Pool { query(statement: 'BEGIN'): Promise<unknown> } }
class Pool extends DriverPool {
  override query(statement: string | {text: string}): Promise<unknown> {return Promise.resolve(statement);}
}
async function check(pool: DriverPool, overridden: Pool) {
  await pool.query('BEGIN');
  await overridden.query('COMMIT');
  await pool.query('COMMIT');
}`,
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [['pg-transaction-on-pool', 9]],
  );
});
