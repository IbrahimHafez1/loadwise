'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projects, nativeAvailable, runOnNativeEngine } = require('./index-rules-fixtures.cjs');
const { prisma, drizzle, typeormCase, sequelize, mongoose } = require('./index-rules-cases.cjs');

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';

function lines(findings) {
  return findings.map(({ line, ruleId }) => [line, ruleId]);
}

test('Prisma: a limited sort that no index serves after the equality prefix', () => {
  const findings = prisma(`export async function feed(storeId: string, id: string) {
  await prisma.order.findFirst({ where: { storeId }, orderBy: { totalEGP: 'desc' } });
  await prisma.order.findMany({ orderBy: { paidAt: 'desc' }, take: 5 });
  await prisma.product.findFirst({ where: { storeId, isActive: true }, orderBy: { priceEGP: 'asc' } });
  await prisma.order.findMany({ where: { storeId }, orderBy: { createdAt: 'desc' }, take: 20 });
  await prisma.order.findMany({ where: { storeId, totalEGP: 5 }, orderBy: [{ createdAt: 'asc' }], take: 1 });
  await prisma.order.findMany({ where: { storeId }, orderBy: { totalEGP: 'desc' } });
  await prisma.order.findFirst({ where: { id }, orderBy: { totalEGP: 'desc' } });
  await prisma.order.findFirst({ orderBy: { id: 'desc' } });
  await prisma.order.findFirst({ where: { storeId }, orderBy: { store: { name: 'asc' } } });
  await prisma.order.findFirst({ where: { storeId, totalEGP: { gt: 1 } }, orderBy: { totalEGP: 'desc' } });
}`);
  assert.deepEqual(lines(findings), [
    [4, 'index-missing-order'],
    [5, 'index-missing-order'],
    [6, 'index-missing-order'],
    [13, 'index-missing-order'],
  ]);
  assert.equal(
    findings[0].message,
    '`Order.totalEGP` orders this limited read after filtering on `storeId`, and no index has (`storeId`, `totalEGP`) ' +
      'as leading columns, so the database sorts every matching row to return the first ones. ' +
      'Add `@@index([storeId, totalEGP])` to model `Order` (test/fixtures/schema/prisma-shop/prisma/schema.prisma:50); ' +
      'on a live database build it with `CREATE INDEX CONCURRENTLY "orders_store_id_total_egp_idx" ON "orders" ("storeId", "totalEGP");`. ' +
      'Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.equal(findings[0].suggestion, '@@index([storeId, totalEGP])');
  assert.match(
    findings[1].message,
    /^`Order.paidAt` orders this limited read and no index starts with it, so the database sorts the whole table/,
  );
  assert.match(
    findings[2].message,
    /Add `@@index\(\[storeId, isActive, priceEGP\]\)`.*Then drop .*, which the new index makes redundant\./,
  );
});

test('Prisma: an unindexed filter and sort merge into one composite', () => {
  const [finding, ...rest] = prisma(`export function page() {
  return prisma.order.findMany({ where: { totalEGP: 5 }, orderBy: { paidAt: 'desc' }, take: 10 });
}`);
  assert.equal(rest.length, 0);
  assert.equal(finding.ruleId, 'index-missing-filter');
  assert.equal(finding.suggestion, '@@index([totalEGP, paidAt])');
  assert.match(finding.message, /Ending it with `paidAt` also serves the sort\./);
});

test('Drizzle: orderBy with limit, served and unserved, and joins stay silent', () => {
  const findings = drizzle(`export async function list(organizationId: string) {
  await db.select().from(cases).where(eq(cases.organizationId, organizationId)).orderBy(desc(cases.updatedAt)).limit(10);
  await db.select().from(cases).where(eq(cases.organizationId, organizationId)).orderBy(cases.name).limit(10);
  await db.select().from(cases).where(eq(cases.organizationId, organizationId)).orderBy(cases.name);
}`);
  assert.deepEqual(lines(findings), [[5, 'index-missing-order']]);
  assert.match(
    findings[0].message,
    /Add `index\('cases_organization_id_name_idx'\)\.on\(table\.organizationId, table\.name\)`/,
  );
});

test('TypeORM: order with take names the property fix and the redundant single-column index', () => {
  const findings = typeormCase(`export class StudentService {
  constructor(private readonly students: Repository<Student>) {}
  async run(schoolId: string, nationalId: string) {
    await this.students.find({ where: { schoolId }, order: { gradeLevel: 'ASC' }, take: 10 });
    await this.students.findOne({ where: { schoolId, nationalId }, order: { gradeLevel: 'ASC' } });
    await this.students.find({ where: { schoolId }, order: { gradeLevel: 'ASC' } });
  }
}`);
  assert.deepEqual(lines(findings), [[6, 'index-missing-order']]);
  assert.match(findings[0].message, /Add `@Index\(\['schoolId', 'gradeLevel'\]\)` to entity `Student`/);
  assert.match(findings[0].message, /Then drop .*school/);
});

test('Sequelize and Mongoose: sorts after an equality filter', () => {
  const sequelizeFindings = sequelize(`import { Sale } from '${projects.sequelize}models';
export async function run(organizationId: string) {
  await Sale.findAll({ where: { organizationId }, order: [['saleDate', 'DESC']], limit: 10 });
  await Sale.findAll({ where: { organizationId }, order: [['customerPhone', 'ASC']], limit: 10 });
}`);
  assert.deepEqual(lines(sequelizeFindings), [[4, 'index-missing-order']]);
  const mongooseFindings = mongoose(`import { Invoice } from '${projects.mongoose}models';
export async function run(tenantId: string) {
  await Invoice.find({ tenantId }).sort({ createdAt: -1 }).limit(20);
  await Invoice.find({ tenantId }).sort({ total: -1 }).limit(5);
  await Invoice.find({ tenantId }).sort({ total: -1 });
}`);
  assert.deepEqual(lines(mongooseFindings), [[4, 'index-missing-order']]);
  assert.match(mongooseFindings[0].message, /Add `invoiceSchema\.index\(\{ tenantId: 1, total: 1 \}\)`/);
});

test('the same order findings on the TypeScript 7 engine', { skip: onNativeEngine || !nativeAvailable() }, () => {
  const result = runOnNativeEngine(__filename);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]\d*/);
});

test('Prisma: an index on the first sort column serves an id tiebreaker through incremental sort', () => {
  const findings = prisma(`export function page(storeId: string) {
  return prisma.order.findMany({ where: { storeId }, orderBy: [{ createdAt: 'desc' }, { totalEGP: 'asc' }], take: 20 });
}`);
  assert.deepEqual(findings, []);
});
