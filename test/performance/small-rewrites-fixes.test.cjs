'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

function fixesFor(context, source, ruleId, files = {}) {
  const { findings } = scanWithFixes(context, { 'package.json': '{}', ...files, 'src/service.ts': source });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function fixedAfter(findings) {
  assert.equal(findings.length, 1, 'expected one finding');
  return onlyChange(findings[0])?.after;
}

test('json-roundtrip-clone becomes structuredClone and asks for review', (context) => {
  const findings = fixesFor(
    context,
    `export function run(items: object[]) {
  const copies: object[] = [];
  for (const item of items) copies.push(JSON.parse(JSON.stringify(item)));
  return copies;
}`,
    'json-roundtrip-clone',
  );
  assert.equal(fixedAfter(findings), 'for (const item of items) copies.push(structuredClone(item));');
  assert.equal(findings[0].fix.requiresReview, true);
  assert.match(findings[0].fix.note, /Dates.*Maps.*undefined/);
});

test('json-roundtrip-clone with a replacer or indentation is reported without a fix', (context) => {
  const findings = fixesFor(
    context,
    `export function run(items: object[]) {
  for (const item of items) JSON.parse(JSON.stringify(item, null, 2));
}`,
    'json-roundtrip-clone',
  );
  assert.deepEqual(findings, []);
});

test('return-newline joins the next line into the return', (context) => {
  const findings = fixesFor(
    context,
    `function labeledBlock() {
  return
  { error: 'Unavailable' }
}
function parenthesized() {
  return
  ({ ok: true });
}`,
    'return-newline',
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((finding) => onlyChange(finding).after),
    ["return { error: 'Unavailable' };", 'return ({ ok: true });'],
  );
  assert.ok(findings.every((finding) => finding.fix.requiresReview));
});

const prismaFiles = {
  'node_modules/@prisma/client/index.d.ts': `export interface StoreDelegate {
  count(args?: object): Promise<number>;
  findFirst(args?: object): Promise<{ id: number } | null>;
}
export declare class PrismaClient { store: StoreDelegate }`,
  'prisma/schema.prisma': 'model Store {\n  id Int @id\n  slug String\n}\n',
};
const prismaHeader = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
declare const where: { slug: string };
`;

test('prisma-count-for-existence uses findFirst selecting the id for each comparison shape', (context) => {
  const cases = [
    [
      '(await prisma.store.count({ where })) > 0',
      'return (await prisma.store.findFirst({ where, select: { id: true } })) !== null;',
    ],
    ['(await prisma.store.count()) === 0', 'return (await prisma.store.findFirst({ select: { id: true } })) === null;'],
    [
      '1 > (await prisma.store.count({ where }))',
      'return (await prisma.store.findFirst({ where, select: { id: true } })) === null;',
    ],
    [
      '(await prisma.store.count({ where })) >= 1',
      'return (await prisma.store.findFirst({ where, select: { id: true } })) !== null;',
    ],
  ];
  for (const [comparison, expected] of cases) {
    const findings = fixesFor(
      context,
      `${prismaHeader}export async function exists() { return ${comparison}; }`,
      'prisma-count-for-existence',
      prismaFiles,
    );
    assert.equal(fixedAfter(findings), `export async function exists() { ${expected} }`);
  }
});

test('prisma-count-for-existence keeps parentheses inside a larger expression', (context) => {
  const findings = fixesFor(
    context,
    `${prismaHeader}export async function exists() { return [(await prisma.store.count({ where })) > 0].length; }`,
    'prisma-count-for-existence',
    prismaFiles,
  );
  assert.match(fixedAfter(findings), /\[\(await prisma\.store\.findFirst/);
});

test('prisma-count-for-existence stays manual without a known single id field', (context) => {
  const source = `${prismaHeader}export async function exists() { return (await prisma.store.count({ where })) > 0; }`;
  const compoundId = { ...prismaFiles, 'prisma/schema.prisma': 'model Store {\n  a Int\n  b Int\n  @@id([a, b])\n}\n' };
  for (const files of [compoundId, { ...prismaFiles, 'prisma/schema.prisma': '' }]) {
    const findings = fixesFor(context, source, 'prisma-count-for-existence', files);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fix, undefined);
  }
});

test('prisma-count-for-existence selects a differently named @id field', (context) => {
  const files = { ...prismaFiles, 'prisma/schema.prisma': 'model Store {\n  slug String @id\n}\n' };
  const findings = fixesFor(
    context,
    `${prismaHeader}export async function exists() { return (await prisma.store.count({ where })) > 0; }`,
    'prisma-count-for-existence',
    files,
  );
  assert.match(fixedAfter(findings), /select: \{ slug: true \}/);
});

const typeormFiles = {
  'node_modules/typeorm/index.d.ts': `export class Repository<Row> {
  findAndCount(options?: object): Promise<[Row[], number]>;
  findAndCountBy(where: object): Promise<[Row[], number]>;
}
export class SelectQueryBuilder<Row> {
  take(size: number): this;
  getManyAndCount(): Promise<[Row[], number]>;
}`,
};
const typeormHeader = `import { Repository, SelectQueryBuilder } from 'typeorm';
declare const logs: Repository<{ id: number }>;
declare const builder: SelectQueryBuilder<{ id: number }>;
declare const where: { schoolId: number };
`;

test('typeorm-unused-count drops the unused total, including a trailing hole', (context) => {
  const findings = fixesFor(
    context,
    `${typeormHeader}export async function read() {
  const [first] = await logs.findAndCount({ where });
  const [second, ,] = await logs.findAndCountBy(where);
  const [third] = await (builder.take(8).getManyAndCount());
  return [first, second, third];
}`,
    'typeorm-unused-count',
    typeormFiles,
  );
  assert.deepEqual(
    findings.map((finding) => onlyChange(finding).after),
    [
      'const first = await logs.find({ where });',
      'const second = await logs.findBy(where);',
      'const third = await (builder.take(8).getMany());',
    ],
  );
});

test('typeorm-unused-count keeps a typed destructuring manual', (context) => {
  const findings = fixesFor(
    context,
    `${typeormHeader}export async function read() {
  const [rows]: [{ id: number }[], number] = await logs.findAndCount({ where });
  return rows;
}`,
    'typeorm-unused-count',
    typeormFiles,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fix, undefined);
});
