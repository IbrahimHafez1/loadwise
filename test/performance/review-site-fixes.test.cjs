'use strict';

const { before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

function findingFor(context, ruleId, source) {
  const { findings } = scanWithFixes(context, { 'a.ts': source });
  return findings.find((finding) => finding.ruleId === ruleId);
}

const literalHeader =
  'declare function a(): Promise<number>;\ndeclare function b(): Promise<number>;\ndeclare function wrap(value: object): object;\n';

test('arrow body that wraps the literal in a call keeps the call', (context) => {
  const finding = findingFor(
    context,
    'serial-awaits-in-literal',
    `${literalHeader}export const build = async () => wrap({ x: await a(), y: await b() });`,
  );
  if (!finding.fix) return;
  assert.match(onlyChange(finding).after, /return wrap\(\{ x: xValue, y: yValue \}\);/);
});

const queueFiles = {
  'node_modules/bullmq/index.d.ts':
    'export declare class Queue { add(name: string, data: any, opts?: any): Promise<{ id: string }>; addBulk(jobs: any[]): Promise<any[]>; }',
};

test('queue add loop with a comment in its body is not rewritten away from the comment', (context) => {
  const { findings } = scanWithFixes(context, {
    ...queueFiles,
    'src/app.ts': `import { Queue } from 'bullmq';
export async function run(queue: Queue, ids: string[]) {
  for (const id of ids) {
    // retries are handled by the worker
    await queue.add('job', { id });
  }
}
`,
  });
  const finding = findings.find((entry) => entry.ruleId === 'queue-add-in-loop');
  assert.ok(finding);
  assert.equal(finding.fix, undefined);
});

const ioredisStub = `export class Redis {
  keys(pattern: string): Promise<string[]>;
  scanStream(options: object): AsyncIterable<string[]>;
}`;

test('redis keys rewrite keeps the export modifier of the declaration', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/ioredis/index.d.ts': ioredisStub,
    'src/cache.ts': `import { Redis } from 'ioredis';
declare const redis: Redis;
export const sessionKeys = await redis.keys('session:*');
`,
  });
  const finding = findings.find((entry) => entry.ruleId === 'redis-keys-command');
  assert.ok(finding?.fix);
  assert.match(onlyChange(finding).after, /^export const sessionKeys: string\[\] = \[\];\nfor await/);
});

// A fix that is withheld leaves the finding reported, with nothing to apply.
function assertNoFix(findings, ruleId) {
  const reported = findings.filter((entry) => entry.ruleId === ruleId);
  assert.ok(reported.length > 0, `${ruleId} should report`);
  assert.deepEqual(
    reported.map((entry) => entry.fix),
    reported.map(() => undefined),
  );
}

const pageCountFiles = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  find(options?: object): Promise<T[]>;
  count(options?: object): Promise<number>;
  findAndCount(options?: object): Promise<[T[], number]>;
}`,
};
const pageCountHeader = "import { Repository } from 'typeorm';\ndeclare const repo: Repository<object>;\n";

test('count then page rewrite is not offered for exported bindings', (context) => {
  const { findings } = scanWithFixes(context, {
    ...pageCountFiles,
    'src/list.ts': `${pageCountHeader}export const total = await repo.count();
export const items = await repo.find({ skip: 0, take: 10 });
`,
  });
  assertNoFix(findings, 'count-then-page-serial');
});

test('count then page rewrite is not offered over a comment between the two reads', (context) => {
  const { findings } = scanWithFixes(context, {
    ...pageCountFiles,
    'src/list.ts': `${pageCountHeader}export async function list() {
  const total = await repo.count();
  // one page of rows
  const items = await repo.find({ skip: 0, take: 10 });
  return { items, total };
}
`,
  });
  assertNoFix(findings, 'count-then-page-serial');
});

test('redis DEL batch under an if without braces is not split into two statements', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/ioredis/index.d.ts': 'export class Redis { del(...keys: string[]): Promise<number>; }',
    'src/cache.ts': `import type { Redis } from 'ioredis';
declare const redis: Redis;
export async function run(names: string[], go: boolean) {
  if (go) await Promise.all(names.map((key) => redis.del(key)));
}
`,
  });
  assertNoFix(findings, 'redis-command-in-loop');
});

test('prisma create loop with a comment in its body is not rewritten away from the comment', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/@prisma/client/index.d.ts': `export interface UserDelegate {
  create(options: object): Promise<{ id: number }>;
  createMany(options: object): Promise<{ count: number }>;
}
export declare class PrismaClient { user: UserDelegate; }`,
    'src/save.ts': `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export async function save(items: { name: string }[]) {
  for (const item of items) {
    // legacy rows keep their own ids
    await prisma.user.create({ data: { name: item.name } });
  }
}
`,
  });
  assertNoFix(findings, 'prisma-query-in-loop');
});

test('pg transaction whose COMMIT is returned unawaited is not wrapped in try/finally', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/@types/pg/index.d.ts': `export class Pool {
  query(statement: string): Promise<{ rows: unknown[] }>;
  connect(): Promise<{ query(statement: string): Promise<unknown>; release(): void }>;
}`,
    'src/transfer.ts': `import { Pool } from 'pg';
export async function run(pool: Pool) {
  await pool.query('BEGIN');
  await pool.query('UPDATE t SET n = 1');
  return pool.query('COMMIT');
}
`,
  });
  assertNoFix(findings, 'pg-transaction-on-pool');
});

test('a cache helper loop under an if without braces gets no multi-statement rewrite', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/ioredis/index.d.ts': 'export default class Redis { del(key: string): Promise<number> }',
    'src/cache.ts': `import Redis from 'ioredis';
export class CacheService {
  constructor(private redis: Redis) {}
  async invalidate(key: string) { await this.redis.del(key); }
}
`,
    'src/main.ts': `import { CacheService } from './cache.js';
export class Invalidator {
  constructor(private cache: CacheService) {}
  async run(keys: string[], go: boolean) {
    if (go) for (const key of keys) await this.cache.invalidate(key);
  }
}
`,
  });
  assertNoFix(findings, 'service-query-in-loop');
});

describe('migration fixes leave NOT NULL inside a CHECK alone', () => {
  const migrations = '../../lib/performance/migrations/';
  const { extractSqlText, prepareDialect, sqlFileInTransaction } = require(migrations + 'extract-sql.cjs');
  const { annotateUnit } = require(migrations + 'operations.cjs');
  const { checkMysqlUnit } = require(migrations + 'rules-mysql.cjs');
  const { checkPostgresUnit } = require(migrations + 'rules-postgres.cjs');
  const migrationBuilders = require('../../lib/performance/site-fixes/migrations.cjs');
  const lockTimeout = "SET lock_timeout = '5s';\n";

  before(() => prepareDialect('postgres'));

  function fixedSql(sql, ruleId, dialect) {
    const { operations, statementCount } = extractSqlText(sql, { dialect, file: 'm.sql' });
    annotateUnit(operations, { inTransaction: sqlFileInTransaction('sql', statementCount), dialect });
    const unit = { file: 'm.sql', framework: 'sql', dialect, operations };
    const findings = dialect === 'mysql' ? checkMysqlUnit(unit) : checkPostgresUnit(unit);
    const finding = findings.find((entry) => entry.ruleId === ruleId);
    assert.ok(finding, `${ruleId} should report`);
    const { edits } = migrationBuilders[ruleId]({ finding, text: sql, load: () => null });
    let result = sql;
    for (const edit of [...edits].sort((left, right) => right.start - left.start))
      result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    return result;
  }

  test('postgres not-null-without-default drops the column NOT NULL, not the one in CHECK', () => {
    const sql = `${lockTimeout}ALTER TABLE t ADD COLUMN c int CHECK (c IS NOT NULL) NOT NULL;`;
    assert.equal(
      fixedSql(sql, 'migration-not-null-without-default', 'postgres'),
      `${lockTimeout}ALTER TABLE t ADD COLUMN c int CHECK (c IS NOT NULL);`,
    );
  });

  test('volatile default drops the column NOT NULL, not the one in CHECK', () => {
    const sql = `${lockTimeout}ALTER TABLE t ADD COLUMN c int DEFAULT random() CHECK (c IS NOT NULL) NOT NULL;`;
    assert.match(
      fixedSql(sql, 'migration-volatile-default', 'postgres'),
      /^SET lock_timeout = '5s';\nALTER TABLE t ADD COLUMN c int CHECK \(c IS NOT NULL\);\n/,
    );
  });

  test('mysql NOT NULL default goes after the column NOT NULL, outside CHECK', () => {
    const sql = 'ALTER TABLE t ADD COLUMN c int CHECK (c IS NOT NULL) NOT NULL;';
    assert.equal(
      fixedSql(sql, 'migration-not-null-without-default', 'mysql'),
      'ALTER TABLE t ADD COLUMN c int CHECK (c IS NOT NULL) NOT NULL DEFAULT 0;',
    );
  });
});
