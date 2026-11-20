const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const delegates = `
  export interface UserDelegate {
    findMany(options?: object): Promise<{ id: number, tenantId: number }[]>;
    groupBy(options: object): Promise<object[]>;
  }
  export declare class PrismaClient { user: UserDelegate }`;
const files = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': delegates,
};
const header = "import type { PrismaClient } from '@prisma/client';\n";
const rules = new Set(['prisma-distinct-in-memory', 'prisma-relation-count-in-list']);

function findings(body) {
  return lint(`${header}async function run(db: PrismaClient, ids: number[]) { ${body} }`, files).filter((finding) =>
    rules.has(finding.ruleId),
  );
}

test('distinct findMany is reported and mentions groupBy', () => {
  const [finding, ...rest] = findings("await db.user.findMany({ distinct: ['tenantId'] });");
  assert.equal(rest.length, 0);
  assert.equal(finding.ruleId, 'prisma-distinct-in-memory');
  assert.match(finding.message, /groupBy/);
});

test('findMany without distinct, and other receivers, are quiet', () => {
  assert.deepEqual(findings('await db.user.findMany({ where: { id: { in: ids } } });'), []);
  assert.deepEqual(
    findings("await db.user.findMany({ distinct: ['id', 'tenantId'] });"),
    [],
    'the primary key is already unique',
  );
  assert.deepEqual(
    findings("const other = { findMany(options: object) { return options; } }; other.findMany({ distinct: ['a'] });"),
    [],
  );
});

test('relation _count in a paged list names the model and relation', () => {
  const [finding, ...rest] = findings(
    'await db.user.findMany({ take: 20, select: { id: true, _count: { select: { posts: true } } } });',
  );
  assert.equal(rest.length, 0);
  assert.equal(finding.ruleId, 'prisma-relation-count-in-list');
  assert.match(finding.message, /User/);
  assert.match(finding.message, /posts/);
  assert.equal(findings('await db.user.findMany({ take: 5, include: { _count: true } });').length, 1);
});

test('unpaged lists, count-free selects and empty _count are quiet', () => {
  assert.deepEqual(findings('await db.user.findMany({ select: { _count: { select: { posts: true } } } });'), []);
  assert.deepEqual(findings('await db.user.findMany({ take: 5, select: { id: true } });'), []);
  assert.deepEqual(findings('await db.user.findMany({ take: 5, include: { posts: { take: 1 } } });'), []);
});

test('nativeDistinct preview feature suppresses the distinct finding', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    ...files,
    'package.json': '{}',
    'prisma/schema.prisma':
      'generator client {\n  provider = "prisma-client-js"\n  previewFeatures = ["nativeDistinct"]\n}\n',
    'main.ts': `${header}async function run(db: PrismaClient) { await db.user.findMany({ distinct: ['tenantId'] }); }`,
  });
  assert.deepEqual(
    scanned.filter((finding) => rules.has(finding.ruleId)),
    [],
  );
});

test('select limited to distinct fields becomes groupBy', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    ...files,
    'package.json': '{}',
    'main.ts': `${header}async function run(db: PrismaClient, ids: number[]) {
  await db.user.findMany({ where: { id: { in: ids } }, select: { tenantId: true }, distinct: ['tenantId'], orderBy: { tenantId: 'asc' } });
  await db.user.findMany({ select: { id: true, tenantId: true }, distinct: ['tenantId'] });
  await db.user.findMany({ select: { tenantId: true }, distinct: ['tenantId'], orderBy: { id: 'asc' } });
  await db.user.findMany({ distinct: ['tenantId'] });
}`,
  });
  const distinct = scanned.filter((finding) => finding.ruleId === 'prisma-distinct-in-memory');
  assert.equal(distinct.length, 4);
  assert.match(
    onlyChange(distinct[0]).after,
    /db\.user\.groupBy\(\{ by: \['tenantId'\], where: \{ id: \{ in: ids \} \}, orderBy: \{ tenantId: 'asc' \} \}\)/,
  );
  for (const unfixable of distinct.slice(1)) assert.equal(unfixable.fix, undefined);
});
