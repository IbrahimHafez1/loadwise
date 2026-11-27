import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { scanWithFixes, onlyChange, requireOnlyChange } from './site-fix-helpers.js';
import { fixOf, noteOf } from '../types/finding-fix.js';

const typeormStub = `export class SelectQueryBuilder<T> {
  skip(value: number): this;
  take(value: number): this;
  where(condition: string): this;
  getCount(): Promise<number>;
  getMany(): Promise<T[]>;
  getManyAndCount(): Promise<[T[], number]>;
}
export class Repository<T> {
  find(options?: object): Promise<T[]>;
  count(options?: object): Promise<number>;
  findAndCount(options?: object): Promise<[T[], number]>;
}`;
const prismaStub = `export interface UserDelegate {
  count(args?: object): Promise<number>;
  findMany(args?: object): Promise<{ id: number }[]>;
}
export class PrismaClient {
  user: UserDelegate;
  $transaction(callback: (tx: { user: UserDelegate }) => unknown): Promise<unknown>;
}`;

function findingsFor(context: TestContext, source: string) {
  const { findings } = scanWithFixes(context, {
    'node_modules/typeorm/index.d.ts': typeormStub,
    'node_modules/@prisma/client/index.d.ts': prismaStub,
    'src/service.ts': source,
  });
  return findings.filter((finding) => finding.ruleId === 'count-then-page-serial');
}

const typeormHeader = `import { Repository, SelectQueryBuilder } from 'typeorm';
declare const qb: SelectQueryBuilder<object>;
declare const repo: Repository<object>;
declare const page: number;
declare const limit: number;
declare const where: object;
`;

test('count then rows on one query builder become getManyAndCount in either order', (context) => {
  const [countFirst, rowsFirst] = findingsFor(
    context,
    `${typeormHeader}export async function list() {
  const total = await qb.getCount();
  const items = await qb.skip(page).take(limit).getMany();
  return { items, total };
}
export async function listReversed() {
  const items = await qb.take(limit).getMany();
  const total = await qb.getCount();
  return { items, total };
}`,
  );
  assert.deepEqual(onlyChange(countFirst), {
    before: 'const total = await qb.getCount();\nconst items = await qb.skip(page).take(limit).getMany();',
    after: 'const [items, total] = await qb.skip(page).take(limit).getManyAndCount();',
  });
  assert.equal(requireOnlyChange(rowsFirst).after, 'const [items, total] = await qb.take(limit).getManyAndCount();');
});

test('repository count and paged find with the same where become findAndCount', (context) => {
  const [finding] = findingsFor(
    context,
    `${typeormHeader}export async function list() {
  const total = await repo.count({ where });
  const rows = await repo.find({ where, skip: page, take: limit });
  return { rows, total };
}`,
  );
  assert.equal(
    requireOnlyChange(finding).after,
    'const [rows, total] = await repo.findAndCount({ where, skip: page, take: limit });',
  );
  // TypeORM still counts after a full page, so the note must not promise a single query.
  assert.match(noteOf(finding), /skips the count query when the page is not full/);
  assert.match(noteOf(finding), /A full page .* still run the count as a second query/);
});

test('prisma count and paged findMany keep their order inside Promise.all', (context) => {
  const [finding] = findingsFor(
    context,
    `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
declare const page: number;
export async function list(tenantId: number) {
  const total = await prisma.user.count({ where: { tenantId } });
  const rows = await prisma.user.findMany({ where: { tenantId }, skip: page, take: 10 });
  return { rows, total };
}`,
  );
  assert.equal(
    requireOnlyChange(finding).after,
    [
      'const [total, rows] = await Promise.all([',
      '  prisma.user.count({ where: { tenantId } }),',
      '  prisma.user.findMany({ where: { tenantId }, skip: page, take: 10 }),',
      ']);',
    ].join('\n'),
  );
  assert.equal(fixOf(finding).note, undefined);
});

test('different filters, unpaged reads, dependent statements and non-ORM receivers are left alone', (context) => {
  const findings = findingsFor(
    context,
    `${typeormHeader}declare const other: object;
declare const cache: { count(options?: object): Promise<number>; find(options?: object): Promise<number[]> };
export async function mismatched() {
  const total = await repo.count({ where });
  const rows = await repo.find({ where: other, skip: page, take: limit });
  return { rows, total };
}
export async function unpaged() {
  const total = await repo.count({ where });
  const rows = await repo.find({ where });
  return { rows, total };
}
export async function dependent() {
  const total = await qb.getCount();
  const rows = await qb.take(total).getMany();
  return rows;
}
export async function filtered() {
  const total = await qb.getCount();
  const rows = await qb.where('x').getMany();
  return { rows, total };
}
export async function notOrm() {
  const total = await cache.count({ where });
  const rows = await cache.find({ where, skip: page });
  return { rows, total };
}
export async function apart() {
  const total = await repo.count({ where });
  console.log(total);
  const rows = await repo.find({ where, take: limit });
  return rows;
}`,
  );
  assert.deepEqual(findings, []);
});

test('annotated bindings are reported without a rewrite', (context) => {
  const [finding] = findingsFor(
    context,
    `${typeormHeader}export async function list() {
  const total: number = await qb.getCount();
  const rows = await qb.getMany();
  return { rows, total };
}`,
  );
  assert.ok(finding);
  assert.equal(finding.fix, undefined);
});

test('paging statements between the count and the rows on the same builder are kept', (context) => {
  const [finding] = findingsFor(
    context,
    `${typeormHeader}export async function list() {
  const total = await qb.getCount();
  qb.skip(page).take(limit);
  const rows = await qb.getMany();
  return { rows, total };
}`,
  );
  const { before, after } = fixOf(finding).changes.map(({ before, after }) => ({ before, after }))[0];
  assert.match(before, /getCount/);
  assert.match(after, /const \[rows, total\] = await qb\.getManyAndCount\(\);/);
  assert.doesNotMatch(after, /getCount/);
  assert.match(after, /qb\.skip\(page\)\.take\(limit\);/);
});

const offsetBuilderStub = typeormStub.replace(
  '  getCount(): Promise<number>;',
  '  offset(value: number): this;\n  limit(value: number): this;\n  leftJoinAndSelect(relation: string, alias: string): this;\n  getCount(): Promise<number>;',
);

test('offset/limit paging is left alone unless the builder is visibly join-free', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/typeorm/index.d.ts':
      offsetBuilderStub + '\nexport class DataSource {\n  createQueryBuilder(): SelectQueryBuilder<object>;\n}',
    'src/service.ts': `import { DataSource, SelectQueryBuilder } from 'typeorm';
declare const dataSource: DataSource;
declare function patientQuery(): SelectQueryBuilder<object>;
export async function joined(page: number, limit: number) {
  const query = dataSource.createQueryBuilder().leftJoinAndSelect('a.b', 'b');
  const total = await query.getCount();
  query.offset(page).limit(limit);
  const rows = await query.getMany();
  return { rows, total };
}
export async function fromHelper(page: number, limit: number) {
  const query = patientQuery();
  const total = await query.getCount();
  query.offset(page).limit(limit);
  const rows = await query.getMany();
  return { rows, total };
}
export async function plain(page: number, limit: number) {
  const query = dataSource.createQueryBuilder();
  const total = await query.getCount();
  query.offset(page).limit(limit);
  const rows = await query.getMany();
  return { rows, total };
}`,
  });
  const reported = findings.filter((finding) => finding.ruleId === 'count-then-page-serial');
  assert.deepEqual(
    reported.map((finding) => finding.line),
    [20],
  );
  assert.match(reported[0].message, /a full page still runs it serially after the rows/);
  assert.doesNotMatch(reported[0].message, /one call|two round trips/);
});
