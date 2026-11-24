import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { requireFix, requireOnlyChange, scanWithFixes, withSecurity } from './site-fix-helpers.cjs';
import type { Finding, FixChange } from '../../lib/shared/types.cjs';
import type { SourceAnalyzer } from '../../lib/performance/types/source-analyzer.cjs';
import type { FileMap } from '../types/project-files.cjs';

const typeormStub: FileMap = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  findOne(options: object): Promise<T | null>;
  findOneBy(filter: object): Promise<T | null>;
  exists(options?: object): Promise<boolean>;
  existsBy(filter: object): Promise<boolean>;
}`,
};

const pgStub: FileMap = {
  'node_modules/@types/pg/index.d.ts': `export class Pool {
  query(statement: string, values?: unknown[]): Promise<unknown>;
}`,
};

function fixesFor(context: TestContext, ruleId: string, source: string, stub?: FileMap, analyzers?: SourceAnalyzer[]) {
  const { findings } = scanWithFixes(context, { 'src/service.ts': source, ...stub }, { analyzers });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function existenceFixes(context: TestContext, body: string) {
  return fixesFor(
    context,
    'typeorm-existence-materialization',
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
${body}`,
    typeormStub,
  );
}

function changedText(finding: Finding) {
  return requireFix(finding)
    .changes.map((change: FixChange) => change.after.trim())
    .join('\n');
}

test('existence read calls the resolved exists method directly', (context) => {
  const [inline, direct] = existenceFixes(
    context,
    `export async function check() {
  if (await repo.findOne({ where: { id: 1 } })) return 1;
  return !(await repo.findOneBy({ id: 2 }));
}`,
  );
  assert.deepEqual(requireOnlyChange(inline), {
    before: 'if (await repo.findOne({ where: { id: 1 } })) return 1;',
    after: 'if (await repo.exists({ where: { id: 1 } })) return 1;',
  });
  assert.deepEqual(requireOnlyChange(direct), {
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

function pgQueries(context: TestContext, queryLine: string) {
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
    assert.equal(requireOnlyChange(finding)?.after, after, line);
  }
});
