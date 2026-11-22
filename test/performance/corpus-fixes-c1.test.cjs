'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { scanWithFixes, onlyChange, withSecurity } = require('./site-fix-helpers.cjs');

const typeormStub = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  findOne(options: object): Promise<T | null>;
  findOneBy(filter: object): Promise<T | null>;
  exists(options?: object): Promise<boolean>;
  existsBy(filter: object): Promise<boolean>;
}`,
};

const pgStub = {
  'node_modules/@types/pg/index.d.ts': `export class Pool {
  query(statement: string, values?: unknown[]): Promise<unknown>;
}`,
};

function fixesFor(context, ruleId, source, stub, analyzers) {
  const { findings } = scanWithFixes(context, { 'src/service.ts': source, ...stub }, { analyzers });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function existenceFixes(context, body) {
  return fixesFor(
    context,
    'typeorm-existence-materialization',
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
${body}`,
    typeormStub,
  );
}

function changedText(finding) {
  return finding.fix.changes.map((change) => change.after.trim()).join('\n');
}

test('existence read calls the resolved exists method directly', (context) => {
  const [inline, direct] = existenceFixes(
    context,
    `export async function check() {
  if (await repo.findOne({ where: { id: 1 } })) return 1;
  return !(await repo.findOneBy({ id: 2 }));
}`,
  );
  assert.deepEqual(onlyChange(inline), {
    before: 'if (await repo.findOne({ where: { id: 1 } })) return 1;',
    after: 'if (await repo.exists({ where: { id: 1 } })) return 1;',
  });
  assert.deepEqual(onlyChange(direct), {
    before: 'return !(await repo.findOneBy({ id: 2 }));',
    after: 'return !(await repo.existsBy({ id: 2 }));',
  });
});

test('existence result variable tested only for truthiness gets a boolean name', (context) => {
  const [department, existing, found] = existenceFixes(
    context,
    `export async function department() {
  const department = await repo.findOneBy({ id: 1 });
  if (!department) throw new Error('missing');
}
export async function existing() {
  const existing = await repo.findOne({ where: { id: 2 } });
  return existing != null;
}
export async function found() {
  const departmentExists = 1;
  const department = await repo.findOneBy({ id: 3 });
  if (department) return departmentExists;
}`,
  );
  assert.equal(
    changedText(department),
    "const departmentExists = await repo.existsBy({ id: 1 });\n  if (!departmentExists) throw new Error('missing');",
  );
  assert.equal(
    changedText(existing),
    'const alreadyExists = await repo.exists({ where: { id: 2 } });\n  return !!alreadyExists;',
  );
  // The boolean name is already taken in scope, so the original name stays.
  assert.equal(changedText(found), 'const department = await repo.existsBy({ id: 3 });');
});

function pgQueries(context, queryLine) {
  return fixesFor(
    context,
    'pg-dynamic-query-text',
    `import { Pool } from 'pg';
async function run(pool: Pool, ms: number, id: number) {
  ${queryLine}
}`,
    pgStub,
    withSecurity,
  );
}

test('utility and DDL statements keep their interpolated text', (context) => {
  for (const line of [
    'await pool.query(`SET statement_timeout = ${ms}`);',
    'await pool.query(`SET LOCAL lock_timeout = ${ms}`);',
    'await pool.query(`ALTER TABLE accounts ALTER COLUMN age SET DEFAULT ${id}`);',
  ]) {
    const matching = pgQueries(context, line);
    assert.ok(matching.length, line);
    assert.equal(matching.filter((finding) => finding.fix).length, 0, line);
  }
});

test('data statements, including leading whitespace and WITH, still become parameters', (context) => {
  for (const [line, after] of [
    [
      'await pool.query(` DELETE FROM accounts WHERE id = ${id}`);',
      "await pool.query(' DELETE FROM accounts WHERE id = $1', [id]);",
    ],
    [
      'await pool.query(`WITH recent AS (SELECT * FROM accounts) SELECT * FROM recent WHERE id = ${id}`);',
      "await pool.query('WITH recent AS (SELECT * FROM accounts) SELECT * FROM recent WHERE id = $1', [id]);",
    ],
    ['await pool.query(`update accounts SET age = ${id}`);', "await pool.query('update accounts SET age = $1', [id]);"],
  ]) {
    const [finding] = pgQueries(context, line);
    assert.equal(onlyChange(finding)?.after, after, line);
  }
});
