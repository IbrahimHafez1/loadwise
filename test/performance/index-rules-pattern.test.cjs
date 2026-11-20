'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projects, nativeAvailable, runOnNativeEngine } = require('./index-rules-fixtures.cjs');
const { prisma, drizzle, typeormCase, sequelize, mongoose } = require('./index-rules-cases.cjs');

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';

function lines(findings) {
  return findings.map(({ line, ruleId }) => [line, ruleId]);
}

test('Prisma: contains, endsWith and insensitive startsWith without a trigram index', () => {
  const findings = prisma(`export async function search(q: string, storeId: string) {
  await prisma.order.findMany({ where: { couponCode: { contains: q } } });
  await prisma.order.findMany({ where: { couponCode: { endsWith: q } } });
  await prisma.order.findMany({ where: { couponCode: { startsWith: q, mode: 'insensitive' } } });
  await prisma.order.findMany({ where: { couponCode: { startsWith: q } } });
  await prisma.product.findMany({ where: { name: { contains: q, mode: 'insensitive' } } });
  await prisma.user.findMany({ where: { name: { contains: q } } });
  await prisma.store.findMany({ where: { name: { contains: q, mode: 'insensitive' } } });
  await prisma.order.findMany({ where: { storeId, couponCode: { contains: q } } });
}`);
  assert.deepEqual(lines(findings), [
    [4, 'index-unusable-pattern'],
    [5, 'index-unusable-pattern'],
    [6, 'index-unusable-pattern'],
  ]);
  assert.equal(
    findings[0].message,
    "`contains` compiles to `LIKE '%...%'`, which a btree index on `Order.couponCode` cannot serve. Add a trigram index: " +
      '`@@index([couponCode(ops: raw("gin_trgm_ops"))], type: Gin)` to model `Order` ' +
      '(test/performance/fixtures/schema/prisma-shop/prisma/schema.prisma:50); on a live database build it with ' +
      '`CREATE INDEX CONCURRENTLY "orders_coupon_code_trgm_idx" ON "orders" USING gin ("couponCode" gin_trgm_ops);` ' +
      '(requires `pg_trgm`), or use `startsWith`. Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.equal(findings[0].suggestion, '@@index([couponCode(ops: raw("gin_trgm_ops"))], type: Gin)');
  assert.match(findings[1].message, /^`endsWith` compiles to `LIKE '%\.\.\.'`/);
  assert.match(findings[2].message, /^`startsWith` with `mode: 'insensitive'` compiles to `ILIKE '\.\.\.%'`/);
  assert.doesNotMatch(findings[2].message, /or use `startsWith`/);
});

test('Drizzle: like and ilike with a leading wildcard on PostgreSQL only', () => {
  const findings = drizzle(`export async function search(q: string) {
  await db.select().from(cases).where(ilike(cases.name, \`%\${q}%\`));
  await db.select().from(cases).where(like(cases.name, q + '%'));
  await db.select().from(cases).where(ilike(cases.name, 'smith%'));
  await db.select().from(abandonedCarts).where(like(abandonedCarts.guestEmail, \`%\${q}\`));
}`);
  assert.deepEqual(lines(findings), [[4, 'index-unusable-pattern']]);
  assert.match(
    findings[0].message,
    /^`ilike` with a leading `%`, which a btree index on `cases.name` cannot serve\. Add a trigram index: `index\('cases_name_trgm_idx'\)\.using\('gin', table\.name\.op\('gin_trgm_ops'\)\)` to the indexes of table `cases`/,
  );
});

test('TypeORM: ILike points to a migration because decorators cannot name an operator class', () => {
  const findings = typeormCase(`export class StudentService {
  constructor(private readonly students: Repository<Student>) {}
  async run(q: string) {
    await this.students.find({ where: { nationalId: ILike(\`%\${q}%\`) } });
    await this.students.find({ where: { guardianPhone: ILike(\`%\${q}\`) } });
  }
}`);
  assert.deepEqual(lines(findings), [[6, 'index-unusable-pattern']]);
  assert.match(
    findings[0].message,
    /Add a trigram index in a migration: `CREATE INDEX CONCURRENTLY "students_national_id_trgm_idx" ON "students" USING gin \("national_id" gin_trgm_ops\);` \(requires `pg_trgm`\)\./,
  );
});

test('Sequelize and Mongoose: iLike wildcards and unanchored regular expressions', () => {
  const sequelizeFindings = sequelize(`import { Sale, Op } from '${projects.sequelize}models';
export async function run(q: string, organizationId: string) {
  await Sale.findAll({ where: { customerPhone: { [Op.iLike]: \`%\${q}%\` } } });
  await Sale.findAll({ where: { organizationId, customerPhone: { [Op.iLike]: \`%\${q}%\` } } });
}`);
  assert.deepEqual(lines(sequelizeFindings), [[3, 'index-unusable-pattern']]);
  assert.match(
    sequelizeFindings[0].message,
    /Add a trigram index: `\{ fields: \[\{ name: 'customerPhone', operator: 'gin_trgm_ops' \}\], using: 'gin' \}` to the `indexes` of model `Sale`/,
  );
  const mongooseFindings = mongoose(`import { Invoice } from '${projects.mongoose}models';
export async function run(tenantId: string, q: string) {
  await Invoice.find({ customerName: /smith/i });
  await Invoice.find({ customerName: /^Smith/ });
  await Invoice.find({ customerName: { $regex: q, $options: 'i' } });
  await Invoice.find({ tenantId, customerName: /smith/i });
}`);
  assert.deepEqual(lines(mongooseFindings), [
    [3, 'index-unusable-pattern'],
    [5, 'index-unusable-pattern'],
  ]);
  assert.equal(
    mongooseFindings[0].message,
    'This regular expression on `Invoice.customerName` is unanchored or case-insensitive, so an index cannot narrow it ' +
      'and MongoDB examines every document (or every key of an index on the field). Anchor it with `^` and keep it ' +
      'case-sensitive, or match a lower-cased copy of the field that is indexed. ' +
      'Collection size is unknown; pass `--schema` to gate this rule by row count.',
  );
});

test('the same pattern findings on the TypeScript 7 engine', { skip: onNativeEngine || !nativeAvailable() }, () => {
  const result = runOnNativeEngine(__filename);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]\d*/);
});
