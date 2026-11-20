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

test('a distinct page becomes groupBy ordered by the distinct field', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    ...files,
    'package.json': '{}',
    'main.ts': `${header}async function run(db: PrismaClient) {
  await db.user.findMany({ select: { tenantId: true }, distinct: ['tenantId'], take: 10 });
}`,
  });
  const [finding] = scanned.filter((candidate) => candidate.ruleId === 'prisma-distinct-in-memory');
  assert.match(
    onlyChange(finding).after,
    /db\.user\.groupBy\(\{ by: \['tenantId'\], orderBy: \{ tenantId: 'asc' \}, take: 10 \}\)/,
  );
  assert.match(finding.fix.note, /ascending order/);
});

const relationSchema = `model User {
  id    Int    @id
  posts Post[]
  notes Note[] @relation("authored")
}
model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}
model Note {
  id       Int  @id
  writerId Int
  writer   User @relation("authored", fields: [writerId], references: [id])
}
`;

function relationCountFindings(context, body) {
  const { findings: scanned } = scanWithFixes(context, {
    ...files,
    'package.json': '{}',
    'prisma/schema.prisma': relationSchema,
    'main.ts': `${header}async function run(db: PrismaClient, active: boolean) {\n${body}\n}`,
  });
  return scanned.filter((finding) => finding.ruleId === 'prisma-relation-count-in-list');
}

test('a paged relation _count becomes one groupBy over the page ids, merged back as _count', (context) => {
  const [finding] = relationCountFindings(
    context,
    [
      '  const rows = await db.user.findMany({',
      '    take: 20,',
      '    select: { id: true, _count: { select: { posts: { where: { published: active } } } } },',
      '  });',
      '  return rows;',
    ].join('\n'),
  );
  assert.deepEqual(onlyChange(finding), {
    before: ['  select: { id: true, _count: { select: { posts: { where: { published: active } } } } },', '});'].join(
      '\n',
    ),
    after: [
      '  select: { id: true },',
      '}).then(async (pageRows) => {',
      '  const pageIds = pageRows.map((row) => row.id);',
      '  const postsGroups = await db.post.groupBy({ by: ["authorId"], where: { AND: [{ authorId: { in: pageIds } }, { published: active }] }, _count: { _all: true } });',
      '  const postsCountById = new Map(postsGroups.map((group) => [group.authorId, group._count._all]));',
      '  return pageRows.map((row) => ({ ...row, _count: { posts: postsCountById.get(row.id) ?? 0 } }));',
      '});',
    ].join('\n'),
  });
  assert.match(finding.fix.note, /separate query/);
});

test('named relations resolve their foreign key; batch transactions and missing schemas get no fix', (context) => {
  const [named] = relationCountFindings(
    context,
    '  return db.user.findMany({ take: 5, include: { _count: { select: { notes: true } } } });',
  );
  assert.match(
    named.fix.changes.at(-1).after,
    /db\.note\.groupBy\(\{ by: \["writerId"\], where: \{ writerId: \{ in: pageIds \} \}/,
  );
  const [batched] = relationCountFindings(
    context,
    '  return (db as any).$transaction([db.user.findMany({ take: 5, include: { _count: { select: { posts: true } } } })]);',
  );
  assert.equal(batched.fix, undefined);
  const [unknown] = relationCountFindings(
    context,
    '  return db.user.findMany({ take: 5, include: { _count: { select: { likes: true } } } });',
  );
  assert.equal(unknown.fix, undefined);
});
