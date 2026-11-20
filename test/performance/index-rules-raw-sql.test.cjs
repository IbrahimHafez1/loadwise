'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { indexFindings, nativeAvailable, runOnNativeEngine } = require('./index-rules-fixtures.cjs');
const { prisma } = require('./index-rules-cases.cjs');

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';
const pgStub = {
  'node_modules/pg/package.json': '{ "name": "pg", "types": "index.d.ts" }',
  'node_modules/pg/index.d.ts':
    'export declare class Pool { query(text: string, values?: unknown[]): Promise<unknown>; }',
};

function lines(findings) {
  return findings.map(({ line, ruleId }) => [line, ruleId]);
}

function pg(body) {
  return indexFindings(`import { Pool } from 'pg';\ndeclare const pool: Pool;\n${body}`, pgStub);
}

test.before(() => require('../../lib/performance/sql/pg-parser.cjs').ensureLoaded());

test('raw SQL against a Prisma model gets the same rules and the schema fix', () => {
  const findings = prisma(`export async function raw(storeId: string, email: string, q: string) {
  await prisma.$queryRawUnsafe('SELECT * FROM orders WHERE "totalEGP" = $1', 5);
  await prisma.$queryRawUnsafe('SELECT * FROM orders WHERE "storeId" = $1 ORDER BY "totalEGP" DESC LIMIT 5', storeId);
  await prisma.$queryRawUnsafe('SELECT id FROM "user" WHERE lower(email) = $1', email);
  await prisma.$queryRawUnsafe('SELECT * FROM orders WHERE "storeId" = $1 OR "totalEGP" = 2', storeId);
  await prisma.$queryRawUnsafe('SELECT * FROM orders o JOIN "user" u ON u.id = o."customerId" WHERE u.role = $1', q);
  await prisma.$queryRawUnsafe(\`SELECT * FROM orders WHERE "\${q}" = 1\`);
  await prisma.$queryRawUnsafe('SELECT * FROM orders WHERE "storeId" = $1 AND "totalEGP" = 2', storeId);
}`);
  assert.deepEqual(lines(findings), [
    [4, 'index-missing-filter'],
    [5, 'index-missing-order'],
    [6, 'index-unusable-expression'],
  ]);
  assert.match(
    findings[0].message,
    /^`Order.totalEGP` is filtered here and no index starts with it.*Add `@@index\(\[totalEGP\]\)` to model `Order`/,
  );
  assert.match(findings[1].message, /Add `@@index\(\[storeId, totalEGP\]\)`/);
  assert.equal(
    findings[2].message,
    '`lower(email)` hides the index on `User.email`. Create `CREATE INDEX CONCURRENTLY "user_email_lower_idx" ON "user" ' +
      '(lower("email"));`, or store a normalized column. Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
});

test('raw SQL without a model reports only a lone pattern or expression, conditionally', () => {
  const findings = pg(`export async function raw(q: string, tenantId: string) {
  await pool.query("SELECT * FROM customers WHERE name ILIKE '%' || $1 || '%'", [q]);
  await pool.query('SELECT * FROM customers WHERE lower(email) = $1', [q]);
  await pool.query('SELECT * FROM customers WHERE tenant_id = $1 AND lower(email) = $2', [tenantId, q]);
  await pool.query('SELECT * FROM customers WHERE tenant_id = $1', [tenantId]);
  await pool.query("SELECT * FROM customers WHERE name ILIKE $1 || '%'", [q]);
}`);
  assert.deepEqual(lines(findings), [
    [4, 'index-unusable-pattern'],
    [5, 'index-unusable-expression'],
  ]);
  assert.equal(
    findings[0].message,
    '`ILIKE` with a leading `%`, which a btree index on `customers.name` cannot serve, so this scans the table unless ' +
      'a trigram index exists. Add a trigram index in a migration: `CREATE INDEX CONCURRENTLY "customers_name_trgm_idx" ' +
      'ON "customers" USING gin ("name" gin_trgm_ops);` (requires `pg_trgm`). ' +
      'Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.equal(
    findings[1].message,
    '`lower(email)` keeps PostgreSQL from using a plain index on `customers.email`, so this scans the table unless an ' +
      'expression index exists. Create `CREATE INDEX CONCURRENTLY "customers_email_lower_idx" ON "customers" ' +
      '(lower("email"));`, or store a normalized column. Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.equal(findings[0].related, undefined);
});

test('raw SQL against a snapshot table uses its indexes and row estimate', () => {
  const { useSnapshot } = require('../../lib/performance/schema/context.cjs');
  try {
    useSnapshot({
      version: 1,
      dialect: 'postgres',
      capturedAt: '2026-11-18T10:00:00Z',
      tables: { 'public.customers': { rowEstimate: 50_000, indexes: [{ keys: [{ column: 'tenant_id' }] }] } },
    });
    const findings = pg(`export async function raw(email: string, tenantId: string) {
  await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
  await pool.query('SELECT * FROM customers WHERE tenant_id = $1 AND email = $2', [tenantId, email]);
}`);
    assert.deepEqual(lines(findings), [[4, 'index-missing-filter']]);
    assert.equal(
      findings[0].message,
      '`customers.email` is filtered here and no index starts with it, so this lookup scans about 50,000 rows ' +
        '(estimated from the snapshot of 2026-11-18). Create it with ' +
        '`CREATE INDEX CONCURRENTLY "customers_email_idx" ON "customers" ("email");`.',
    );
  } finally {
    useSnapshot(undefined);
  }
});

test('the same raw SQL findings on the TypeScript 7 engine', { skip: onNativeEngine || !nativeAvailable() }, () => {
  const result = runOnNativeEngine(__filename);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]\d*/);
});
