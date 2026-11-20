'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const pgStub = {
  'node_modules/@types/pg/index.d.ts': `type Input = string | {text: string, values?: unknown[]};
export class Pool {
  query(statement: Input, values?: unknown[]): Promise<unknown>;
  connect(): Promise<PoolClient>;
}
export class Client {query(statement: Input, values?: unknown[]): Promise<unknown>}
export interface PoolClient extends Client {release(): void}`,
};

function fixFor(context, ruleId, source, stub) {
  const { findings } = scanWithFixes(context, { 'src.ts': source, ...stub });
  const matching = findings.filter((finding) => finding.ruleId === ruleId);
  return { matching, change: matching.length === 1 ? onlyChange(matching[0]) : undefined };
}

function pgQuery(context, queryLine) {
  return fixFor(
    context,
    'pg-dynamic-query-text',
    [
      "import { Pool } from 'pg';",
      'async function run(pool: Pool, id: number, name: string, limit: number, table: string) {',
      `  ${queryLine}`,
      '}',
    ].join('\n'),
    pgStub,
  );
}

test('dynamic pg query text becomes numbered parameters', (context) => {
  assert.deepEqual(pgQuery(context, 'await pool.query(`SELECT * FROM accounts WHERE id = ${id}`);').change, {
    before: 'await pool.query(`SELECT * FROM accounts WHERE id = ${id}`);',
    after: "await pool.query('SELECT * FROM accounts WHERE id = $1', [id]);",
  });
  assert.equal(
    pgQuery(
      context,
      "await pool.query(`SELECT * FROM accounts WHERE name = '${name}' AND age >= ${id} LIMIT ${limit}`);",
    ).change.after,
    "await pool.query('SELECT * FROM accounts WHERE name = $1 AND age >= $2 LIMIT $3', [name, id, limit]);",
  );
  assert.equal(
    pgQuery(context, "await pool.query(`SELECT * FROM accounts WHERE status = 'open' AND id = ${id}`);").change.after,
    "await pool.query(`SELECT * FROM accounts WHERE status = 'open' AND id = $1`, [id]);",
  );
});

test('dynamic pg query text with identifiers or unclear positions gets no fix', (context) => {
  for (const line of [
    'await pool.query(`SELECT * FROM ${table} WHERE id = ${id}`);',
    'await pool.query(`SELECT * FROM accounts ORDER BY ${name}`);',
    "await pool.query(`SELECT * FROM accounts WHERE name LIKE '%${name}%'`);",
    'await pool.query(`SELECT * FROM accounts WHERE id IN (${id})`);',
    'await pool.query(`SELECT * FROM accounts WHERE id = ${id}::int`);',
    'await pool.query(`SELECT * FROM accounts WHERE id = $1 AND name = ${name}`, [1]);',
    'await pool.query(`SELECT * FROM accounts WHERE id = $1 AND name = ${name}`);',
    "await pool.query(`SELECT * FROM accounts WHERE note = 'id = ${id}'`);",
    'await pool.query(`SELECT * FROM accounts WHERE data ->> ${name} = 1`);',
    'await pool.query(`UPDATE accounts SET age = ${id}; DELETE FROM accounts`);',
    'await pool.query({ text: `SELECT * FROM accounts WHERE id = ${id}` });',
  ]) {
    const { matching } = pgQuery(context, line);
    assert.equal(matching.filter((finding) => finding.fix).length, 0, line);
  }
});
