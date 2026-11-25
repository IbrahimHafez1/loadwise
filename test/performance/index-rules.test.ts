import assert from 'node:assert/strict';
import test from 'node:test';
import { projects, projectFiles, nativeAvailable, runOnNativeEngine } from './index-rules-fixtures.js';
import { prisma, drizzle, typeormCase, sequelize, mongoose } from './index-rules-cases.js';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.js';
import { reasonOf } from '../types/finding-reason.js';
import { findSourceFile } from '../types/source-files.js';
import { asSnapshot } from '../types/partial-snapshot.js';
import { exampleFor } from '../../editor/performance-examples.cjs';
import { useSnapshot } from '../../lib/performance/schema/context.js';
import { withProgram } from './helpers.js';
import { analyzeFile } from '../../lib/performance/analyze.js';

test('Prisma: an unindexed equality filter reports the composite fix, schema line and DDL', () => {
  const [finding, ...rest] = prisma(`export async function list(couponCode: string, total: number) {
  return prisma.order.findMany({ where: { totalEGP: total, paidAt: { gte: new Date() } } });
}`);
  assert.equal(rest.length, 0);
  assert.equal(finding.line, 4);
  assert.equal(finding.ruleId, 'index-missing-filter');
  assert.equal(
    finding.message,
    '`Order.totalEGP` and `Order.paidAt` are filtered here and no index starts with any of them, so this lookup scans the table as it grows. ' +
      'Add `@@index([totalEGP, paidAt], map: "orders_total_egp_paid_at_idx")` to model `Order` (test/performance/fixtures/schema/prisma-shop/prisma/schema.prisma:50); ' +
      'on a live database build it with `CREATE INDEX CONCURRENTLY "orders_total_egp_paid_at_idx" ON "orders" ("totalEGP", "paidAt");`. ' +
      'Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.equal(finding.suggestion, '@@index([totalEGP, paidAt], map: "orders_total_egp_paid_at_idx")');
  assert.deepEqual(finding.related, [
    {
      file: 'test/performance/fixtures/schema/prisma-shop/prisma/schema.prisma',
      line: 50,
      column: 7,
      message: 'Model `Order` is declared here.',
    },
  ]);
});

test('Prisma: a non-leading column names the index it sits in', () => {
  const [finding] = prisma(`export function active() {
  return prisma.product.findMany({ where: { isActive: true, priceEGP: 10 } });
}`);
  assert.match(finding.message, /^`Product.priceEGP` is filtered here and no index starts with it/);
  const [nonLeading] = prisma(`export function recent(since: Date) {
  return prisma.order.findMany({ where: { createdAt: { gte: since } } });
}`);
  assert.match(
    nonLeading.message,
    /^`Order.createdAt` is filtered here but is only the 2nd column of the index on \(`storeId`, `createdAt`, `id`\)/,
  );
});

test('Prisma: covered conjuncts, keys, booleans, enums, OR and dynamic filters stay silent', () => {
  const findings = prisma(`export async function quiet(storeId: string, filter: object, id: string, code: string) {
  await prisma.order.findMany({ where: { storeId, totalEGP: 5 } });
  await prisma.order.findMany({ where: { AND: [{ storeId }, { totalEGP: 5 }] } });
  await prisma.order.findFirst({ where: { id } });
  await prisma.order.findMany({ where: { couponCode: code } });
  await prisma.order.findUnique({ where: { totalEGP: 5 } });
  await prisma.user.findMany({ where: { active: true } });
  await prisma.order.findMany({ where: { status: 'PAID' } });
  await prisma.order.findMany({ where: { OR: [{ totalEGP: 5 }, { storeId }] } });
  await prisma.order.findMany({ where: { totalEGP: 5, customer: { email: code } } });
  await prisma.order.findMany({ where: filter });
  await prisma.order.findMany({ where: { ...filter, totalEGP: 5 } });
  await prisma.order.findMany({ where: { totalEGP: { not: 5 } } });
  await prisma.orderSummary.findMany({ where: { total: 5 } });
  await prisma.user.findMany({ where: { email: code } });
}`);
  assert.deepEqual(findings, []);
});

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';

test('Prisma: queries in test sources get no index advice', { skip: onNativeEngine }, () => {
  const query = 'export const rows = prisma.order.findMany({ where: { totalEGP: 1 } });';
  const [main] = prisma(query);
  assert.equal(main.contextualReason, undefined, 'main.ts is not a test source');
  // Only main.ts is analyzed by lint(), so analyze the test file directly on the JS engine.
  const testFile = `${projects.prisma}tests/orders.test.ts`;
  const testSource = `import { PrismaClient } from '../node_modules/.prisma/client';
declare const prisma: PrismaClient;
${query}`;
  const findings = withProgram(
    '',
    projectFiles('prisma', { 'tests/orders.test.ts': testSource }),
    (program: ProgramAdapter) =>
      analyzeFile(
        program,
        findSourceFile(program, (file) => file.fileName.endsWith(testFile.slice(2))),
      ),
  ).filter((finding: Finding) => finding.ruleId === 'index-missing-filter');
  assert.deepEqual(findings, []);
});

test('Prisma: a missing-index finding in seed data setup is contextual', { skip: onNativeEngine }, () => {
  const seedFile = `${projects.prisma}prisma/seed.ts`;
  const seedSource = `import { PrismaClient } from '../node_modules/.prisma/client';
declare const prisma: PrismaClient;
export const rows = prisma.order.findMany({ where: { totalEGP: 1 } });`;
  const [finding] = withProgram(
    '',
    projectFiles('prisma', { 'prisma/seed.ts': seedSource }),
    (program: ProgramAdapter) =>
      analyzeFile(
        program,
        findSourceFile(program, (file) => file.fileName.endsWith(seedFile.slice(2))),
      ),
  ).filter((reported) => reported.ruleId === 'index-missing-filter');
  assert.equal(finding.contextualReason, 'Query in seed or demo-data setup.');
});

test('Prisma: a missing-index finding in an operator script is contextual', { skip: onNativeEngine }, () => {
  const scriptFile = `${projects.prisma}scripts/backfill.ts`;
  const scriptSource = `import { PrismaClient } from '../node_modules/.prisma/client';
declare const prisma: PrismaClient;
export const rows = prisma.order.findMany({ where: { totalEGP: 1 } });`;
  const [finding] = withProgram(
    '',
    projectFiles('prisma', { 'scripts/backfill.ts': scriptSource }),
    (program: ProgramAdapter) =>
      analyzeFile(
        program,
        findSourceFile(program, (file) => file.fileName.endsWith(scriptFile.slice(2))),
      ),
  ).filter((reported) => reported.ruleId === 'index-missing-filter');
  assert.match(reasonOf(finding), /^Query in operator tooling/);
});

test('Drizzle: reports unindexed filters with the drizzle fix and stays quiet on covered ones', () => {
  const findings =
    drizzle(`export async function load(organizationId: string, head: number, since: Date, archived: boolean) {
  await db.select().from(cases).where(eq(cases.head, head));
  await db.select().from(cases).where(and(eq(cases.organizationId, organizationId), eq(cases.head, head)));
  await db.select().from(cases).where(eq(cases.id, organizationId));
  await db.select().from(cases).where(eq(cases.archived, archived));
  await db.select().from(cases).where(or(eq(cases.head, head), eq(cases.id, organizationId)));
  await db.update(cases).set({ head }).where(gte(cases.updatedAt, since));
  await db.select().from(abandonedCarts).where(gt(abandonedCarts.lastUpdated, since));
  await db.select().from(abandonedCarts).where(eq(abandonedCarts.userId, head));
  await db.select().from(cases).where(and(eq(cases.organizationId, organizationId), isNull(cases.email)));
}`);
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [
      [4, 'index-missing-filter'],
      [9, 'index-missing-filter'],
      [10, 'index-missing-filter'],
    ],
  );
  assert.equal(
    findings[0].message,
    '`cases.head` is filtered here and no index starts with it, so this lookup scans the table as it grows. ' +
      "Add `index('cases_head_idx').on(table.head)` to the indexes of table `cases` (test/performance/fixtures/schema/drizzle-app/schema.ts:6); " +
      'on a live database build it with `CREATE INDEX CONCURRENTLY "cases_head_idx" ON "cases" ("head");`. ' +
      'Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.match(
    findings[1].message,
    /^`cases.updatedAt` is filtered here but is only the 2nd column of `cases_organization_updated`/,
  );
  assert.match(
    findings[2].message,
    /^`abandoned_carts.lastUpdated` is filtered here but is only the 2nd column of `user_last_updated_idx`.*ALGORITHM=INPLACE LOCK=NONE;`\./,
  );
});

test('TypeORM: reports through Repository<T>, getRepository and EntityManager; migrations silence', () => {
  const findings = typeormCase(`export class StudentService {
  constructor(private readonly students: Repository<Student>) {}
  async run(level: number, phone: string, schoolId: string, nationalId: string) {
    await this.students.find({ where: { gradeLevel: level } });
    await dataSource.getRepository(Student).findBy({ gradeLevel: In([level]) });
    await dataSource.manager.find(Student, { where: { gradeLevel: MoreThan(level) } });
    await this.students.find({ where: { schoolId, gradeLevel: level } });
    await this.students.findOneBy({ nationalId });
    await this.students.find({ where: { guardianPhone: phone } });
    await this.students.find({ where: { active: true } });
    await this.students.find({ where: { gradeLevel: Raw('x') } });
    await this.students.find({ where: [{ gradeLevel: level }] });
    await this.students.find({ where: { enrolledAt: MoreThan(new Date()) } });
  }
}`);
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [
      [6, 'index-missing-filter'],
      [7, 'index-missing-filter'],
      [8, 'index-missing-filter'],
      [10, 'index-missing-filter'],
    ],
  );
  assert.equal(
    findings[0].message,
    '`Student.gradeLevel` is filtered here and no index starts with it, so this lookup scans the table as it grows. ' +
      "Add `@Index('students_grade_level_idx')` to the `gradeLevel` property of entity `Student` (test/performance/fixtures/schema/typeorm-app/entities.ts:13); " +
      'on a live database build it with `CREATE INDEX CONCURRENTLY "students_grade_level_idx" ON "students" ("grade_level");`. ' +
      'Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.match(
    findings[3].message,
    /^`Student.nationalId` is filtered here and no index starts with it/,
    'the partial unique index is not named',
  );
  // Line 11 filters `guardianPhone`, which only the partial index in src/migrations covers: silent.
  // Line 15 filters `enrolledAt`, led only by a partial index whose predicate is not checked: silent.
});

test('Sequelize: reports @Table models and honours the indexes option and Op keys', () => {
  const source = `import { Sale, Op } from '${projects.sequelize}models';
export async function run(phone: string, organizationId: string, from: Date) {
  await Sale.findAll({ where: { customerPhone: phone } });
  await Sale.findAll({ where: { organizationId, customerPhone: phone } });
  await Sale.findAll({ where: { saleDate: { [Op.gte]: from } } });
  await Sale.findOne({ where: { invoiceNumber: phone } });
  await Sale.findAll({ where: { [Op.or]: [{ customerPhone: phone }] } });
}`;
  const findings = sequelize(source);
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [
      [3, 'index-missing-filter'],
      [5, 'index-missing-filter'],
    ],
  );
  assert.match(
    findings[0].message,
    /Add `\{ name: 'sales_customer_phone_idx', fields: \['customerPhone'\] \}` to the `indexes` of model `Sale`/,
  );
  assert.match(findings[1].message, /only the 2nd column of `sale_org_date`/);
});

test('Mongoose: reports unindexed filters with a schema.index fix and no SQL', () => {
  const source = `import { Invoice } from '${projects.mongoose}models';
export async function run(tenantId: string, name: string) {
  await Invoice.find({ customerName: name });
  await Invoice.find({ tenantId, customerName: name });
  await Invoice.find({ total: { $gte: 10 } }).lean();
  await Invoice.find({ status: 'paid' });
  await Invoice.find({ $or: [{ customerName: name }] });
  await Invoice.find({ 'items.sku': name });
}`;
  const findings = mongoose(source);
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [
      [3, 'index-missing-filter'],
      [5, 'index-missing-filter'],
    ],
  );
  assert.equal(
    findings[0].message,
    '`Invoice.customerName` is filtered here and no index starts with it, so this lookup scans the collection as it grows. ' +
      "Add `invoiceSchema.index({ customerName: 1 }, { name: 'invoices_customer_name_idx' })` (test/performance/fixtures/schema/mongoose-app/models.ts:2). " +
      'Collection size is unknown; pass `--schema` to gate this rule by row count.',
  );
  const example = exampleFor('index-missing-filter', 'typescript', findings[0].message);
  assert.ok(example);
  assert.match(example.code, /^orderSchema\.index\(/);
  const plainExample = exampleFor('index-missing-filter', 'typescript', 'no Mongoose here');
  assert.ok(plainExample);
  assert.match(plainExample.code, /^CREATE INDEX/);
});

test('a snapshot gates by row count and replaces the declared indexes', () => {
  const body = 'export const rows = prisma.order.findMany({ where: { totalEGP: 1 } });';
  try {
    useSnapshot(
      asSnapshot({
        version: 1,
        dialect: 'postgres',
        capturedAt: '2026-11-18T10:00:00Z',
        tables: { 'public.orders': { rowEstimate: 2_400_000, indexes: [] } },
      }),
    );
    const [large] = prisma(body);
    assert.match(
      large.message,
      /so this lookup scans about 2,400,000 rows \(estimated from the snapshot of 2026-11-18\)\./,
    );
    assert.doesNotMatch(large.message, /size is unknown/);
    useSnapshot(asSnapshot({ version: 1, dialect: 'postgres', tables: { orders: { rowEstimate: 900 } } }));
    const [small] = prisma(body);
    assert.equal(small.contextualReason, 'Table has about 900 rows.');
    useSnapshot(
      asSnapshot({
        version: 1,
        dialect: 'postgres',
        tables: { orders: { rowEstimate: 50_000, indexes: [{ keys: [{ column: 'totalEGP' }] }] } },
      }),
    );
    assert.deepEqual(prisma(body), [], 'the snapshot index covers the column');
  } finally {
    useSnapshot(undefined);
  }
});

test('the same findings on the TypeScript 7 engine', { skip: onNativeEngine || !nativeAvailable() }, () => {
  const result = runOnNativeEngine(import.meta.filename);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]\d*/);
});

test('Prisma: a foreign key in the filter keys the suggested index on the foreign key alone', () => {
  const [finding, ...rest] = prisma(`export function owned(customerId: string, since: Date) {
  return prisma.order.findFirst({ where: { customerId, totalEGP: 5, paidAt: { gt: since } } });
}`);
  assert.equal(rest.length, 0);
  assert.equal(finding.ruleId, 'index-missing-filter');
  assert.equal(finding.suggestion, '@@index([customerId], map: "orders_customer_id_idx")');
  assert.match(finding.message, /`Order.customerId`, `Order.totalEGP` and `Order.paidAt` are filtered here/);
});
