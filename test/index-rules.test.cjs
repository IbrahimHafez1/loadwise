'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  projects,
  projectFiles,
  indexFindings,
  nativeAvailable,
  runOnNativeEngine,
} = require('./index-rules-fixtures.cjs');

const prismaImport = `import { PrismaClient } from '${projects.prisma}node_modules/.prisma/client';\ndeclare const prisma: PrismaClient;\n`;

function prisma(body) {
  return indexFindings(prismaImport + body, projectFiles('prisma', {}));
}

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
      'Add `@@index([totalEGP, paidAt])` to model `Order` (test/fixtures/schema/prisma-shop/prisma/schema.prisma:50); ' +
      'on a live database build it with `CREATE INDEX CONCURRENTLY "orders_total_egp_paid_at_idx" ON "orders" ("totalEGP", "paidAt");`. ' +
      'Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.equal(finding.suggestion, '@@index([totalEGP, paidAt])');
  assert.deepEqual(finding.related, [
    {
      file: 'test/fixtures/schema/prisma-shop/prisma/schema.prisma',
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

test('Prisma: test sources are contextual', { skip: onNativeEngine }, () => {
  const query = 'export const rows = prisma.order.findMany({ where: { totalEGP: 1 } });';
  const [main] = prisma(query);
  assert.equal(main.contextualReason, undefined, 'main.ts is not a test source');
  // Only main.ts is analyzed by lint(), so analyze the test file directly on the JS engine; loading
  // analyze.cjs here rather than at the top keeps the native leg free of the JS compiler.
  const { withProgram } = require('./helpers.cjs');
  const { analyzeFile } = require('../lib/analyze.cjs');
  const testFile = `${projects.prisma}tests/orders.test.ts`;
  const testSource = `import { PrismaClient } from '../node_modules/.prisma/client';
declare const prisma: PrismaClient;
${query}`;
  const findings = withProgram('', projectFiles('prisma', { 'tests/orders.test.ts': testSource }), (program) =>
    analyzeFile(
      program,
      program.getSourceFiles().find((file) => file.fileName.endsWith(testFile.slice(2))),
    ),
  ).filter((finding) => finding.ruleId === 'index-missing-filter');
  assert.deepEqual(
    findings.map((finding) => finding.contextualReason),
    ['Query in a test source.'],
  );
});

const drizzleSchema = `import { pgTable, uuid, text, integer, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { mysqlTable, int, varchar, timestamp as mysqlTimestamp, index as mysqlIndex } from 'drizzle-orm/mysql-core';
export { eq, and, or, gt, gte, like, ilike, inArray, desc, sql } from 'drizzle-orm';
export type { Database } from 'drizzle-orm/pg-core';
export const cases = pgTable(
  'cases',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    name: text().notNull(),
    email: text('email'),
    archived: boolean('archived'),
    head: integer().notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [index('cases_organization_updated').on(table.organizationId, table.updatedAt.desc())],
);
export const abandonedCarts = mysqlTable(
  'abandoned_carts',
  {
    id: int('id').primaryKey(),
    userId: int('user_id'),
    guestEmail: varchar('guest_email', { length: 255 }),
    lastUpdated: mysqlTimestamp('last_updated').notNull(),
  },
  (table) => [mysqlIndex('user_last_updated_idx').on(table.userId, table.lastUpdated)],
);
`;

function drizzle(body) {
  const source = `import { cases, abandonedCarts, eq, and, or, gt, gte, like, ilike, inArray, desc, sql, type Database } from '${projects.drizzle}schema';
declare const db: Database;
${body}`;
  return indexFindings(source, projectFiles('drizzle', { 'schema.ts': drizzleSchema }));
}

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
      "Add `index('cases_head_idx').on(table.head)` to the indexes of table `cases` (test/fixtures/schema/drizzle-app/schema.ts:5); " +
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

const typeormEntities = `import { Column, Entity, Index, PrimaryGeneratedColumn, Repository, DataSource, In, MoreThan, Raw, IsNull } from 'typeorm';
export { Repository, DataSource, In, MoreThan, Raw, IsNull };
export abstract class TenantBaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Index()
  @Column('uuid', { name: 'school_id' })
  schoolId!: string;
}
@Entity('students')
@Index(['schoolId', 'nationalId'], { unique: true, where: '"deleted_at" IS NULL' })
export class Student extends TenantBaseEntity {
  @Column({ name: 'national_id' })
  nationalId!: string;
  @Column({ name: 'grade_level' })
  gradeLevel!: number;
  @Column({ name: 'guardian_phone' })
  guardianPhone!: string;
  @Column({ type: 'boolean' })
  active!: boolean;
}
`;

function typeormCase(body) {
  const source = `import { Student, Repository, DataSource, In, MoreThan, Raw, IsNull } from '${projects.typeorm}entities';
declare const dataSource: DataSource;
${body}`;
  return indexFindings(source, projectFiles('typeorm', { 'entities.ts': typeormEntities }));
}

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
      'Add `@Index()` to the `gradeLevel` property of entity `Student` (test/fixtures/schema/typeorm-app/entities.ts:12); ' +
      'on a live database build it with `CREATE INDEX CONCURRENTLY "students_grade_level_idx" ON "students" ("grade_level");`. ' +
      'Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.match(
    findings[3].message,
    /^`Student.nationalId` is filtered here and no index starts with it/,
    'the partial unique index is not named',
  );
  // Line 11 filters `guardianPhone`, which only the partial index in src/migrations covers: silent.
});

const sequelizeModels = `import { Table, Column, Model, DataType, PrimaryKey, Index } from 'sequelize-typescript';
import { Op } from 'sequelize';
export { Op };
@Table({
  tableName: 'Sales',
  indexes: [{ name: 'sale_org_date', fields: ['organizationId', 'saleDate'] }],
})
export class Sale extends Model<Sale> {
  @PrimaryKey
  @Column(DataType.UUID)
  id!: string;
  @Column(DataType.UUID)
  organizationId!: string;
  @Column(DataType.DATE)
  saleDate!: Date;
  @Index
  @Column(DataType.STRING)
  invoiceNumber!: string;
  @Column(DataType.STRING)
  customerPhone!: string;
}
`;

test('Sequelize: reports @Table models and honours the indexes option and Op keys', () => {
  const source = `import { Sale, Op } from '${projects.sequelize}models';
export async function run(phone: string, organizationId: string, from: Date) {
  await Sale.findAll({ where: { customerPhone: phone } });
  await Sale.findAll({ where: { organizationId, customerPhone: phone } });
  await Sale.findAll({ where: { saleDate: { [Op.gte]: from } } });
  await Sale.findOne({ where: { invoiceNumber: phone } });
  await Sale.findAll({ where: { [Op.or]: [{ customerPhone: phone }] } });
}`;
  const findings = indexFindings(source, projectFiles('sequelize', { 'models.ts': sequelizeModels }));
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [
      [3, 'index-missing-filter'],
      [5, 'index-missing-filter'],
    ],
  );
  assert.match(findings[0].message, /Add `\{ fields: \['customerPhone'\] \}` to the `indexes` of model `Sale`/);
  assert.match(findings[1].message, /only the 2nd column of `sale_org_date`/);
});

const mongooseModels = `import mongoose, { Schema } from 'mongoose';
const invoiceSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    customerName: String,
    status: { type: String, enum: ['draft', 'paid'] },
    total: Number,
  },
  { timestamps: true },
);
invoiceSchema.index({ tenantId: 1, createdAt: -1 });
export const Invoice = mongoose.model('Invoice', invoiceSchema);
`;

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
  const findings = indexFindings(source, projectFiles('mongoose', { 'models.ts': mongooseModels }));
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
      'Add `invoiceSchema.index({ customerName: 1 })` (test/fixtures/schema/mongoose-app/models.ts:2). ' +
      'Collection size is unknown; pass `--schema` to gate this rule by row count.',
  );
});

test('a snapshot gates by row count and replaces the declared indexes', () => {
  const { useSnapshot } = require('../lib/schema/context.cjs');
  const body = 'export const rows = prisma.order.findMany({ where: { totalEGP: 1 } });';
  try {
    useSnapshot({
      version: 1,
      dialect: 'postgres',
      capturedAt: '2026-11-18T10:00:00Z',
      tables: { 'public.orders': { rowEstimate: 2_400_000, indexes: [] } },
    });
    const [large] = prisma(body);
    assert.match(
      large.message,
      /so this lookup scans about 2,400,000 rows \(estimated from the snapshot of 2026-11-18\)\./,
    );
    assert.doesNotMatch(large.message, /size is unknown/);
    useSnapshot({ version: 1, dialect: 'postgres', tables: { orders: { rowEstimate: 900 } } });
    const [small] = prisma(body);
    assert.equal(small.contextualReason, 'Table has about 900 rows.');
    useSnapshot({
      version: 1,
      dialect: 'postgres',
      tables: { orders: { rowEstimate: 50_000, indexes: [{ keys: [{ column: 'totalEGP' }] }] } },
    });
    assert.deepEqual(prisma(body), [], 'the snapshot index covers the column');
  } finally {
    useSnapshot(undefined);
  }
});

test('the same findings on the TypeScript 7 engine', { skip: onNativeEngine || !nativeAvailable() }, () => {
  const result = runOnNativeEngine(__filename);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]\d*/);
});
