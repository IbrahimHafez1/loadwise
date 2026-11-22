'use strict';

const assert = require('node:assert/strict');
const { before, describe, test } = require('node:test');
const ts = require('typescript');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');
const { extractCodeFile } = require('../../lib/performance/migrations/extract-code.cjs');
const { prepareDialect } = require('../../lib/performance/migrations/extract-sql.cjs');
const { annotateUnit } = require('../../lib/performance/migrations/operations.cjs');
const { checkPostgresUnit } = require('../../lib/performance/migrations/rules-postgres.cjs');
const migrationBuilders = require('../../lib/performance/site-fixes/migrations.cjs');

describe('queue-add-in-loop fix', () => {
  const queueFiles = {
    'node_modules/bullmq/index.d.ts': `export declare class Queue { add(name: string, data: any, opts?: any): Promise<{ id: string }>; addBulk(jobs: any[]): Promise<any[]>; }`,
  };

  function scan(context, body, parameters = 'ids: string[]') {
    const source = `import { Queue } from 'bullmq';\nexport async function run(queue: Queue, ${parameters}) {\n${body}\n}\n`;
    return scanWithFixes(context, { ...queueFiles, 'src/app.ts': source }).findings.filter(
      (finding) => finding.ruleId === 'queue-add-in-loop',
    );
  }

  test('copies a Set, Map or generator through Array.from instead of calling .map on it', (context) => {
    const findings = scan(
      context,
      `  for (const id of ids) {
    await queue.add('set', { id });
  }
  for (const [key, value] of entries) {
    await queue.add('map', { key, value });
  }
  for (const id of generate()) {
    await queue.add('generated', { id });
  }`,
      'ids: Set<string>, entries: Map<string, number>, generate: () => Generator<string>',
    );
    assert.equal(findings.length, 3);
    assert.match(onlyChange(findings[0]).after, /queue\.addBulk\(Array\.from\(ids, \(id\) => \(\{ name: 'set'/);
    assert.match(
      onlyChange(findings[1]).after,
      /queue\.addBulk\(Array\.from\(entries, \(\[key, value\]\) => \(\{ name: 'map'/,
    );
    assert.match(onlyChange(findings[2]).after, /queue\.addBulk\(Array\.from\(generate\(\), \(id\) =>/);
  });

  test('keeps .map for arrays and readonly arrays, and parenthesizes an awaited array', (context) => {
    const findings = scan(
      context,
      `  for (const id of ids) {
    await queue.add('array', { id });
  }
  for (const id of frozen) {
    await queue.add('readonly', { id });
  }
  for (const id of await load()) {
    await queue.add('loaded', { id });
  }`,
      'ids: string[], frozen: readonly string[], load: () => Promise<string[]>',
    );
    assert.equal(findings.length, 3);
    assert.match(onlyChange(findings[0]).after, /queue\.addBulk\(ids\.map\(\(id\) =>/);
    assert.match(onlyChange(findings[1]).after, /queue\.addBulk\(frozen\.map\(\(id\) =>/);
    assert.match(onlyChange(findings[2]).after, /queue\.addBulk\(\(await load\(\)\)\.map\(\(id\) =>/);
  });

  test('offers no rewrite when the collection is typed any or unknown', (context) => {
    const findings = scan(
      context,
      `  for (const id of loose) {
    await queue.add('any', { id });
  }`,
      'loose: any',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fix, undefined);
  });

  test('carries comments in the loop body into the mapper', (context) => {
    const findings = scan(
      context,
      `  for (const id of ids) {
    // One job per id, retried by the worker.
    await queue.add('job', { id }); // ids are unique
  }
  let queued = 0;
  for (const id of ids) {
    // Normalized so the worker sees one spelling.
    const key = id.toLowerCase();
    await queue.add('job', { key });
    queued++;
  }`,
    );
    assert.equal(findings.length, 2);
    assert.equal(
      onlyChange(findings[0]).after,
      [
        'await queue.addBulk(ids.map((id) => {',
        '  // One job per id, retried by the worker.',
        "  return { name: 'job', data: { id } }; // ids are unique",
        '}));',
      ].join('\n'),
    );
    assert.equal(
      onlyChange(findings[1]).after,
      [
        'const jobs = ids.map((id) => {',
        '  // Normalized so the worker sees one spelling.',
        '  const key = id.toLowerCase();',
        "  return { name: 'job', data: { key } };",
        '});',
        'await queue.addBulk(jobs);',
        'queued += jobs.length;',
      ].join('\n'),
    );
  });

  test('still refuses comments it cannot carry: in the loop header, inside the add, or among the counters', (context) => {
    const findings = scan(
      context,
      `  let queued = 0;
  for (const id of /* all of them */ ids) {
    await queue.add('header', { id });
  }
  for (const id of ids) {
    await queue.add('call', /* payload */ { id });
  }
  for (const id of ids) {
    await queue.add('counter', { id });
    // counted for the log
    queued++;
  }`,
    );
    assert.equal(findings.length, 3);
    for (const finding of findings) assert.equal(finding.fix, undefined);
  });
});

describe('prisma-distinct-in-memory fix', () => {
  const prismaFiles = {
    'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
    'node_modules/.prisma/client/index.d.ts': `
  export interface UserDelegate {
    findMany(options?: object): Promise<{ id: number, tenantId: number }[]>;
    groupBy(options: object): Promise<object[]>;
  }
  export declare class PrismaClient { user: UserDelegate }`,
    'package.json': '{}',
  };

  function distinctFindings(context, body) {
    const source = `import type { PrismaClient } from '@prisma/client';\nasync function run(db: PrismaClient, ids: number[]) {\n${body}\n}\n`;
    return scanWithFixes(context, { ...prismaFiles, 'main.ts': source }).findings.filter(
      (finding) => finding.ruleId === 'prisma-distinct-in-memory',
    );
  }

  test('keeps comments inside a kept option and withholds the fix when a dropped part holds one', (context) => {
    const [kept, dropped, between] = distinctFindings(
      context,
      `  await db.user.findMany({ where: { id: { in: ids } /* active only */ }, select: { tenantId: true }, distinct: ['tenantId'] });
  await db.user.findMany({ select: { tenantId: true /* the tenant */ }, distinct: ['tenantId'] });
  await db.user.findMany({
    // Tenants with at least one user.
    select: { tenantId: true },
    distinct: ['tenantId'],
  });`,
    );
    assert.match(
      onlyChange(kept).after,
      /db\.user\.groupBy\(\{ by: \['tenantId'\], where: \{ id: \{ in: ids \} \/\* active only \*\/ \} \}\)/,
    );
    assert.equal(dropped.fix, undefined);
    assert.equal(between.fix, undefined);
  });
});

