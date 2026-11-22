'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { nativeAvailable, runOnNativeEngine } = require('./index-rules-fixtures.cjs');
const { prisma, drizzle } = require('./index-rules-cases.cjs');

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';

function lines(findings) {
  return findings.map(({ line, ruleId }) => [line, ruleId]);
}

test('Prisma: insensitive equality compiles to ILIKE, which only a trigram index serves', () => {
  const findings = prisma(`export async function lookup(email: string, name: string, storeId: string) {
  await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  await prisma.user.findMany({ where: { name: { equals: name, mode: 'insensitive' } } });
  await prisma.store.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  await prisma.order.findMany({ where: { storeId, couponCode: { in: [name], mode: 'insensitive' } } });
}`);
  assert.deepEqual(lines(findings), [[4, 'index-unusable-expression']]);
  assert.equal(
    findings[0].message,
    "`mode: 'insensitive'` compiles to `ILIKE`, which a btree index on `User.email` cannot serve. Add a trigram index: " +
      '`@@index([email(ops: raw("gin_trgm_ops"))], type: Gin, map: "user_email_trgm_idx")` to model `User` ' +
      '(test/performance/fixtures/schema/prisma-shop/prisma/schema.prisma:12); on a live database build it with ' +
      '`CREATE INDEX CONCURRENTLY "user_email_trgm_idx" ON "user" USING gin ("email" gin_trgm_ops);` (requires `pg_trgm`), ' +
      'or store the value lower-cased and match it with `equals`. Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
});

test('Drizzle: functions and casts around a column, unless an expression index matches', () => {
  const findings =
    drizzle(`export async function lookup(email: string, name: string, day: string, organizationId: string) {
  await db.select().from(cases).where(eq(sql\`lower(\${cases.email})\`, email));
  await db.select().from(cases).where(eq(sql\`lower(\${cases.name})\`, name));
  await db.select().from(cases).where(eq(sql\`\${cases.updatedAt}::date\`, day));
  await db.select().from(cases).where(and(eq(cases.organizationId, organizationId), eq(sql\`lower(\${cases.email})\`, email)));
  await db.select().from(abandonedCarts).where(eq(sql\`lower(\${abandonedCarts.guestEmail})\`, email));
}`);
  assert.deepEqual(lines(findings), [
    [4, 'index-unusable-expression'],
    [6, 'index-unusable-expression'],
  ]);
  assert.equal(
    findings[0].message,
    '`lower(email)` keeps PostgreSQL from using a plain index on `cases.email`. ' +
      "Add `index('cases_email_lower_idx').on(sql`lower(${table.email})`)` to the indexes of table `cases` " +
      '(test/performance/fixtures/schema/drizzle-app/schema.ts:6); on a live database build it with ' +
      '`CREATE INDEX CONCURRENTLY "cases_email_lower_idx" ON "cases" (lower("email"));`, or store a normalized column. ' +
      'Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.match(findings[1].message, /ON "cases" \(\("updated_at"::date\)\);`/);
});

test('the same expression findings on the TypeScript 7 engine', { skip: onNativeEngine || !nativeAvailable() }, () => {
  const result = runOnNativeEngine(__filename);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]\d*/);
});
