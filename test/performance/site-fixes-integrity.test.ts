import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { analyzeSources } from '../../lib/performance/projects.js';
import { attachSiteFixes } from '../../lib/performance/site-fix.js';
import { dedent, withSecurity } from './site-fix-helpers.js';
import type { Finding, FindingFix, FixChange } from '../../lib/shared/types.js';
import { fixOf, noteOf, fileOf } from '../types/finding-fix.js';
import type { PerformancePolicy } from '../../lib/performance/types/performance-policy.js';
import type { FileMap } from '../types/project-files.js';
import type { ApplyResult } from '../../lib/editor/apply-fix.js';
import { applyFixes } from '../../lib/performance/fix-cli.js';
import { applyFix } from '../../lib/editor/apply-fix.js';

// Scans `source` as src.ts beside the package stubs, with an optional query policy, and returns the
// findings of `ruleId` with their site fixes attached.
function findingsFor(
  context: TestContext,
  ruleId: string,
  source: string,
  stubs: FileMap = {},
  policy?: PerformancePolicy,
) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-integrity-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries({ 'src.ts': source, ...stubs })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  const { findings } = analyzeSources({ files: [path.join(root, 'src.ts')], policy, analyzers: withSecurity });
  attachSiteFixes(findings, { comments: false });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

// The fixed file text, applying every change of `fix` to `source`.
function fixedSource(source: string, fix: Pick<FindingFix, 'changes'>) {
  let result = source;
  for (const change of fix.changes) {
    assert.ok(result.includes(change.before), 'change applies to the current text');
    result = result.replace(change.before, () => change.after);
  }
  return result;
}

function changeOf(finding: Finding) {
  assert.equal(fixOf(finding).changes.length, 1);
  const { before, after } = fixOf(finding).changes[0];
  return { before: dedent(before), after: dedent(after) };
}

const pgStub = {
  'node_modules/@types/pg/index.d.ts': `type Input = string | {text: string, values?: unknown[]};
export class Pool {
  constructor(config?: object);
  query(statement: Input, values?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}
export class Client {query(statement: Input, values?: unknown[]): Promise<{ rows: unknown[] }>}
export interface PoolClient extends Client {release(): void}`,
};

test('pg transaction on the pool moves BEGIN to COMMIT onto one released client', (context) => {
  const source = [
    "import { Pool } from 'pg';",
    'export async function transfer(pool: Pool, from: number, to: number) {',
    "  await pool.query('BEGIN');",
    "  await pool.query('UPDATE accounts SET balance = balance - 1 WHERE id = $1', [from]);",
    "  await pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [to]);",
    "  await pool.query('COMMIT');",
    "  await pool.query('SELECT 1');",
    '}',
  ].join('\n');
  const findings = findingsFor(context, 'pg-transaction-on-pool', source, pgStub);
  assert.equal(findings.length, 2);
  assert.deepEqual(changeOf(findings[0]).after.split('\n'), [
    'const client = await pool.connect();',
    'try {',
    "  await client.query('BEGIN');",
    "  await client.query('UPDATE accounts SET balance = balance - 1 WHERE id = $1', [from]);",
    "  await client.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [to]);",
    "  await client.query('COMMIT');",
    '} catch (error) {',
    "  await client.query('ROLLBACK');",
    '  throw error;',
    '} finally {',
    '  client.release();',
    '}',
  ]);
  assert.deepEqual(findings[1].fix, findings[0].fix);
  const fixed = fixedSource(source, fixOf(findings[0]));
  assert.equal(findingsFor(context, 'pg-transaction-on-pool', fixed, pgStub).length, 0);
});

test('pg transaction with its own rollback keeps it and only adds the release', (context) => {
  const source = [
    "import { Pool } from 'pg';",
    'export async function save(pool: Pool, id: number) {',
    '  try {',
    "    await pool.query('BEGIN');",
    "    await pool.query('DELETE FROM items WHERE id = $1', [id]);",
    "    await pool.query('COMMIT');",
    '  } catch (failure) {',
    "    await pool.query('ROLLBACK');",
    '    throw failure;',
    '  }',
    '}',
  ].join('\n');
  const [finding] = findingsFor(context, 'pg-transaction-on-pool', source, pgStub);
  const { after } = changeOf(finding);
  assert.match(after, /^const client = await pool\.connect\(\);\ntry \{\n {2}try \{/);
  assert.ok(after.includes("    await client.query('ROLLBACK');"));
  assert.ok(!after.includes('catch (error)'));
  assert.ok(after.endsWith('} finally {\n  client.release();\n}'));
});

test('long pg transactions are wrapped in place and leave indentation to the formatter', (context) => {
  const updates = [0, 1, 2].flatMap((index) => [
    '  await pool.query(',
    '    `UPDATE t',
    `     SET n = ${index}`,
    '     WHERE id = 1`,',
    '  );',
  ]);
  const source = [
    "import { Pool } from 'pg';",
    'export async function run(pool: Pool) {',
    "  await pool.query('BEGIN');",
    ...updates,
    "  await pool.query('COMMIT');",
    '}',
  ].join('\n');
  const [finding] = findingsFor(context, 'pg-transaction-on-pool', source, pgStub);
  const fixed = fixedSource(source, fixOf(finding));
  assert.ok(fixed.includes("  const client = await pool.connect();\n  try {\n  await client.query('BEGIN');"));
  assert.ok(fixed.includes("  await client.query('COMMIT');\n  } catch (error) {"));
  assert.ok(fixed.endsWith('  } finally {\n    client.release();\n  }\n}'));
  assert.match(noteOf(finding), /formatter/);
  assert.equal(findingsFor(context, 'pg-transaction-on-pool', fixed, pgStub).length, 0);
});

test('pg transaction on the pool gets no fix when the pool escapes or results are used later', (context) => {
  const cases = {
    'pool passed to a helper': [
      "  await pool.query('BEGIN');",
      '  await audit(pool);',
      "  await pool.query('COMMIT');",
    ],
    'result read after the transaction': [
      "  await pool.query('BEGIN');",
      "  const { rows } = await pool.query('SELECT 1');",
      "  await pool.query('COMMIT');",
      '  return rows;',
    ],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const source = [
      "import { Pool } from 'pg';",
      'declare function audit(pool: Pool): Promise<void>;',
      'export async function run(pool: Pool) {',
      ...lines,
      '}',
    ].join('\n');
    const findings = findingsFor(context, 'pg-transaction-on-pool', source, pgStub);
    assert.ok(findings.length > 0, name);
    assert.equal(findings.filter((finding) => finding.fix).length, 0, name);
  }
});

test('pg unreleased checkout becomes a pool query', (context) => {
  const source = [
    "import { Pool } from 'pg';",
    'declare const pool: Pool;',
    'export async function run() {',
    "  return (await pool.connect()).query('SELECT 1');",
    '}',
  ].join('\n');
  const [finding] = findingsFor(context, 'pg-unreleased-checkout', source, pgStub);
  assert.deepEqual(changeOf(finding), {
    before: "return (await pool.connect()).query('SELECT 1');",
    after: "return pool.query('SELECT 1');",
  });
  const begin = source.replace("'SELECT 1'", "'BEGIN'");
  const [beginFinding] = findingsFor(context, 'pg-unreleased-checkout', begin, pgStub);
  assert.equal(beginFinding.fix, undefined);
});

const poolStubs = {
  ...pgStub,
  'node_modules/redis/index.d.ts': 'export function createClient(): {connect(): Promise<void>; quit(): Promise<void>}',
  'node_modules/@types/express/index.d.ts':
    'export interface Router { get(path: string, handle: (request: { query: object }) => unknown): void }',
};

test('pool created per request moves to module scope and drops the per-call close', (context) => {
  const source = [
    "import { Pool } from 'pg';",
    "import type { Router } from 'express';",
    'declare const router: Router;',
    'const connectionString = process.env.DATABASE_URL;',
    '',
    '// Lists users.',
    "router.get('/users', async () => {",
    '  const pool = new Pool({ connectionString, max: 5 });',
    "  const { rows } = await pool.query('SELECT id FROM users');",
    '  await pool.end();',
    '  return rows;',
    '});',
  ].join('\n');
  const [finding] = findingsFor(context, 'pool-created-per-request-or-item', source, poolStubs);
  const fixed = fixedSource(source, fixOf(finding));
  assert.equal(
    fixed,
    [
      "import { Pool } from 'pg';",
      "import type { Router } from 'express';",
      'declare const router: Router;',
      'const connectionString = process.env.DATABASE_URL;',
      '',
      'const pool = new Pool({ connectionString, max: 5 });',
      '',
      '// Lists users.',
      "router.get('/users', async () => {",
      "  const { rows } = await pool.query('SELECT id FROM users');",
      '  return rows;',
      '});',
    ].join('\n'),
  );
  assert.match(noteOf(finding), /shutdown/);
  assert.equal(findingsFor(context, 'pool-created-per-request-or-item', fixed, poolStubs).length, 0);
});

test('pool created from request data, a later constant or a reconnecting client gets no fix', (context) => {
  const cases = {
    'request data': [
      "router.get('/users', async (request) => {",
      '  const pool = new Pool(request.query);',
      "  return pool.query('SELECT 1');",
      '});',
    ],
    'constant declared later': [
      "router.get('/users', async () => {",
      '  const pool = new Pool({ max: later });',
      "  return pool.query('SELECT 1');",
      '});',
      'const later = 5;',
    ],
    'shadowed name closed in a nested scope': [
      "router.get('/users', async () => {",
      '  const pool = new Pool();',
      '  const run = (pool) => { pool.end(); };',
      "  return pool.query('SELECT 1');",
      '});',
    ],
    'name shadowed by a class expression': [
      "router.get('/users', async () => {",
      '  const pool = new Pool();',
      '  const Shadow = class pool { static { pool.end(); } };',
      "  return pool.query('SELECT 1');",
      '});',
    ],
    'name shadowed in a switch case clause': [
      "router.get('/users', async (request) => {",
      '  const pool = new Pool();',
      '  switch (request.query) {',
      '    case 1:',
      '      const pool = makePool();',
      '      if (request) { pool.end(); }',
      '  }',
      "  return pool.query('SELECT 1');",
      '});',
    ],
    'redis client connected per call': [
      "router.get('/users', async () => {",
      '  const client = createClient();',
      '  await client.connect();',
      '  await client.quit();',
      '});',
    ],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const source = [
      "import { Pool } from 'pg';",
      "import { createClient } from 'redis';",
      "import type { Router } from 'express';",
      'declare const router: Router;',
      ...lines,
    ].join('\n');
    const findings = findingsFor(context, 'pool-created-per-request-or-item', source, poolStubs);
    assert.equal(findings.length, 1, name);
    assert.equal(findings[0].fix, undefined, name);
  }
});

const prismaStub = {
  'node_modules/@prisma/client/index.d.ts': `
  export interface Stock { quantity: number; version: number; }
  export interface StockDelegate {
    update(args: object): Promise<Stock>;
    create(args: object): Promise<Stock>;
  }
  export interface TransactionClient { stock: StockDelegate }
  export declare class PrismaClient {
    stock: StockDelegate;
    $transaction<T>(fn: (tx: TransactionClient) => Promise<T>, options?: object): Promise<T>;
  }`,
};

test('outer Prisma client inside a transaction callback switches to the callback client', (context) => {
  const source = [
    "import { PrismaClient } from '@prisma/client';",
    'export async function run(db: PrismaClient) {',
    '  return db.$transaction(async (tx) => {',
    '    await db.stock.create({});',
    '    await tx.stock.update({});',
    '  });',
    '}',
  ].join('\n');
  const [finding] = findingsFor(context, 'prisma-transaction-client-escape', source, prismaStub);
  assert.deepEqual(changeOf(finding), { before: 'await db.stock.create({});', after: 'await tx.stock.create({});' });
  assert.match(noteOf(finding), /rolls back with it/);
});

test('transaction callback without a parameter receives one; this-bound clients are replaced whole', (context) => {
  const source = [
    "import { PrismaClient } from '@prisma/client';",
    'class Warehouse {',
    '  constructor(readonly db: PrismaClient) {}',
    '  save() {',
    '    return this.db.$transaction(async () => {',
    '      await this.db.stock.update({});',
    '    });',
    '  }',
    '}',
  ].join('\n');
  const [finding] = findingsFor(context, 'prisma-transaction-client-escape', source, prismaStub);
  const fixed = fixedSource(source, fixOf(finding));
  assert.ok(fixed.includes('return this.db.$transaction(async (tx) => {\n      await tx.stock.update({});'));
  assert.equal(findingsFor(context, 'prisma-transaction-client-escape', fixed, prismaStub).length, 0);
});

test('transaction callback that rebinds its client name gets no fix', (context) => {
  const source = [
    "import { PrismaClient } from '@prisma/client';",
    'export async function run(db: PrismaClient, other: PrismaClient) {',
    '  return db.$transaction(async (tx) => {',
    '    { const tx = other; await db.stock.create({}); }',
    '  });',
    '}',
  ].join('\n');
  const [finding] = findingsFor(context, 'prisma-transaction-client-escape', source, prismaStub);
  assert.equal(finding.fix, undefined);
});

const scopeStubs = {
  'node_modules/.prisma/client/index.d.ts': [
    'type Options = { where?: unknown, data?: unknown, select?: { id?: boolean } };',
    'export interface InvoiceDelegate {',
    '  findMany(options?: Options): Promise<unknown>; findUnique(options?: Options): Promise<unknown>;',
    '  updateMany(options?: Options): Promise<unknown>;',
    '}',
    'export declare class PrismaClient { invoice: InvoiceDelegate }',
  ].join('\n'),
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/@app/auth/index.d.ts': 'export function requireTenantId(): string;',
};
const prismaPolicy = {
  prismaScopes: { Invoice: { field: 'tenantId', from: '@app/auth', export: 'requireTenantId' } },
};

test('Prisma scope adds the in-scope authorized value to where', (context) => {
  const lines = [
    'db.invoice.findMany({ where: { paid: true } });',
    'db.invoice.findMany({ select: { id: true } });',
    'db.invoice.findUnique({',
    '  where: {',
    '    id: input.id,',
    '  },',
    '});',
    'db.invoice.findMany({ where: filter });',
    'db.invoice.findMany({ where: { tenantId: input.tenant } });',
  ];
  const source = [
    "import { PrismaClient } from '@prisma/client';",
    "import { requireTenantId } from '@app/auth';",
    'const db = new PrismaClient();',
    'export async function list(input: { id: number; tenant: string }, filter: object) {',
    '  const tenantId = requireTenantId();',
    ...lines.map((line) => '  ' + line),
    '}',
  ].join('\n');
  const findings = findingsFor(context, 'prisma-scope-unverified', source, scopeStubs, prismaPolicy);
  assert.deepEqual(
    findings.map((finding) => finding.fix && changeOf(finding).after),
    [
      'db.invoice.findMany({ where: { tenantId, paid: true } });',
      'db.invoice.findMany({ where: { tenantId }, select: { id: true } });',
      'tenantId,\nid: input.id,',
      'db.invoice.findMany({ where: { AND: [filter, { tenantId }] } });',
      undefined,
    ],
  );
  let fixed = source;
  for (const finding of findings.filter((candidate) => candidate.fix)) fixed = fixedSource(fixed, fixOf(finding));
  assert.equal(findingsFor(context, 'prisma-scope-unverified', fixed, scopeStubs, prismaPolicy).length, 1);
});

test('Prisma scope without an in-scope value of that name gets no fix', (context) => {
  const source = [
    "import { PrismaClient } from '@prisma/client';",
    'const db = new PrismaClient();',
    'export async function list(tenantId: string) {',
    '  return db.invoice.findMany({ where: { paid: true } });',
    '}',
  ].join('\n');
  const [finding] = findingsFor(context, 'prisma-scope-unverified', source, scopeStubs, prismaPolicy);
  assert.equal(finding.fix, undefined);
});

test('scope fixes require an initialized binding from the configured authorization helper', (context) => {
  const source = [
    "import { PrismaClient } from '@prisma/client';",
    "import { requireTenantId as currentTenant } from '@app/auth';",
    'const db = new PrismaClient();',
    'export function list(input: string) {',
    '  const tenantId = currentTenant();',
    '  { db.invoice.findMany({}); }',
    '  { const tenantId = String(input); db.invoice.findMany({}); }',
    '  { db.invoice.findMany({}); const tenantId = currentTenant(); }',
    '  for (const tenantId of [input]) { db.invoice.findMany({}); }',
    '}',
  ].join('\n');
  const findings = findingsFor(context, 'prisma-scope-unverified', source, scopeStubs, prismaPolicy);
  assert.deepEqual(
    findings.map((finding) => Boolean(finding.fix)),
    [true, false, false, false],
  );
});

const drizzleStubs = {
  'node_modules/drizzle-orm/pg-core/db.d.ts': `
    export class Query extends Promise<unknown> {
      from(table: unknown): Query; where(clause: unknown): Query; set(data: object): Query;
      returning(selection?: object): Query; orderBy(column: unknown): Query;
    }
    export class Database { select(selection?: object): Query; update(table: unknown): Query; delete(table: unknown): Query; }`,
  'node_modules/drizzle-orm/sql/expressions/conditions.d.ts': `
    export interface BinaryOperator { (left: unknown, right: unknown): unknown }
    export declare const eq: BinaryOperator; export declare const ne: BinaryOperator;
    export declare function and(...terms: unknown[]): unknown;
    export declare function or(...terms: unknown[]): unknown;
    export declare function isNull(column: unknown): unknown;`,
  'node_modules/drizzle-orm/index.d.ts': "export * from './sql/expressions/conditions';",
  'node_modules/@app/schema/index.d.ts':
    'export declare const invoices: { id: object; tenantId: object; paid: object; archived: object };',
  'node_modules/@app/auth/index.d.ts': 'export declare function tenant(): string;',
};
const drizzlePolicy = {
  drizzleScopes: { invoices: { tableFrom: '@app/schema', field: 'tenantId', from: '@app/auth', export: 'tenant' } },
};

test('Drizzle scope adds eq(table.field, value) to the query and imports what it needs', (context) => {
  const source = [
    "import type { Database } from 'drizzle-orm/pg-core/db';",
    "import { eq as equal } from 'drizzle-orm';",
    "import { invoices as bills } from '@app/schema';",
    "import { tenant } from '@app/auth';",
    'export async function run(db: Database, id: number) {',
    '  const tenantId = tenant();',
    '  await db.select().from(bills).orderBy(bills.id);',
    '  await db.delete(bills).where(equal(bills.id, id));',
    '}',
  ].join('\n');
  const findings = findingsFor(context, 'drizzle-scope-unverified', source, drizzleStubs, drizzlePolicy);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    changeOf(findings[0]).after,
    'await db.select().from(bills).where(equal(bills.tenantId, tenantId)).orderBy(bills.id);',
  );
  const deleteChanges = fixOf(findings[1]).changes.map((change: FixChange) => change.after.trim());
  assert.deepEqual(deleteChanges, [
    "import { eq as equal, and } from 'drizzle-orm';",
    'await db.delete(bills).where(and(equal(bills.tenantId, tenantId), equal(bills.id, id)));',
  ]);
  let fixed = fixedSource(source, fixOf(findings[1]));
  fixed = fixedSource(fixed, fixOf(findings[0]));
  assert.equal(findingsFor(context, 'drizzle-scope-unverified', fixed, drizzleStubs, drizzlePolicy).length, 0);
});

test('Drizzle same-boolean update skips rows that already hold the value only after review', async (context) => {
  const source = [
    "import type { Database } from 'drizzle-orm/pg-core/db';",
    "import { invoices } from '@app/schema';",
    'export async function archiveAll(db: Database) {',
    '  await db.update(invoices).set({ archived: true });',
    '}',
  ].join('\n');
  const [finding] = findingsFor(context, 'drizzle-unfiltered-write', source, drizzleStubs);
  const fixed = fixedSource(source, fixOf(finding));
  assert.ok(fixed.includes("import { invoices } from '@app/schema';\nimport { or, ne, isNull } from 'drizzle-orm';"));
  assert.ok(
    fixed.includes(
      'await db.update(invoices).set({ archived: true }).where(or(ne(invoices.archived, true), isNull(invoices.archived)));',
    ),
  );
  assert.match(noteOf(finding), /affected-row count/);
  assert.equal(fixOf(finding).requiresReview, true);
  await applyFixes([finding], { all: true });
  assert.equal(fs.readFileSync(fileOf(finding), 'utf8'), source);
  assert.equal(findingsFor(context, 'drizzle-unfiltered-write', fixed, drizzleStubs).length, 0);
});

test('Drizzle unfiltered writes with no implied filter get no fix', (context) => {
  const source = [
    "import type { Database } from 'drizzle-orm/pg-core/db';",
    "import { invoices } from '@app/schema';",
    'export async function run(db: Database) {',
    '  await db.delete(invoices);',
    '  await db.update(invoices).set({ paid: true }).returning();',
    '}',
  ].join('\n');
  const findings = findingsFor(context, 'drizzle-unfiltered-write', source, drizzleStubs);
  assert.equal(findings.length, 2);
  assert.equal(findings.filter((finding) => finding.fix).length, 0);
});

test('Drizzle same-boolean update keeps a where argument that runs code and replaces a plain undefined', (context) => {
  const source = [
    "import type { Database } from 'drizzle-orm/pg-core/db';",
    "import { invoices } from '@app/schema';",
    'declare function audit(): void;',
    'export async function run(db: Database) {',
    '  await db.update(invoices).set({ archived: true }).where(void audit());',
    '  await db.update(invoices).set({ archived: true }).where(undefined);',
    '}',
  ].join('\n');
  const findings = findingsFor(context, 'drizzle-unfiltered-write', source, drizzleStubs);
  assert.deepEqual(
    findings.map((finding) => Boolean(finding.fix)),
    [false, true],
  );
});

const notNullSchemaStub = {
  'schema.ts': `
    interface ColumnBuilder { notNull(): ColumnBuilder; default(value: boolean): ColumnBuilder }
    declare function pgTable<Columns>(name: string, columns: Columns): Columns;
    declare function boolean(name: string): ColumnBuilder;
    export const packages = pgTable('packages', {
      mostPopular: boolean('most_popular').default(false).notNull(),
      featured: boolean('featured').default(false),
    });`,
};

function repeatedBooleanUpdates(column: string) {
  return [
    "import type { Database } from 'drizzle-orm/pg-core/db';",
    "import { eq } from 'drizzle-orm';",
    "import { packages } from './schema';",
    "import { other } from './other';",
    '',
    '',
    '',
    '',
    'export async function run(db: Database) {',
    `  await db.update(packages).set({ ${column}: false });`,
    '',
    '',
    '',
    '',
    `  await db.update(packages).set({ ${column}: false });`,
    '',
    '',
    '',
    '',
    `  await db.update(packages).set({ ${column}: false });`,
    '}',
  ].join('\n');
}

// Applies fixes one after another the way the CLI does, through the real change applier.
function applyEachFix(source: string, findings: Finding[]) {
  let text = source;
  const results: ApplyResult[] = [];
  for (const finding of findings) {
    results.push(
      applyFix(fixOf(finding), {
        readFile: () => text,
        writeFile: (_file, updated) => {
          text = updated;
        },
      }),
    );
  }
  return { text, results };
}

test('Drizzle same-boolean fixes in one file compose: the shared import is added once in any order', (context) => {
  const source = repeatedBooleanUpdates('featured');
  const findings = findingsFor(context, 'drizzle-unfiltered-write', source, { ...drizzleStubs, ...notNullSchemaStub });
  assert.equal(findings.length, 3);
  for (const order of [findings, [...findings].reverse(), [findings[1], findings[2], findings[0]]]) {
    const { text, results } = applyEachFix(source, order);
    assert.ok(
      results.every((result) => !result.error),
      JSON.stringify(results),
    );
    const drizzleImports = text.match(/import \{[^}]*\} from 'drizzle-orm'/g);
    assert.ok(drizzleImports);
    assert.equal(drizzleImports.length, 1);
    const importedNames = drizzleImports[0]
      .replaceAll(/^import \{|\}.*$/g, '')
      .split(',')
      .map((name) => name.trim());
    assert.deepEqual(
      ['or', 'ne', 'isNull'].filter((name) => !importedNames.includes(name)),
      [],
    );
    assert.equal(text.match(/\.where\(or\(ne\(packages\.featured, false\)/g)?.length, 3);
  }
});

test('Drizzle same-boolean update on a NOT NULL column omits the isNull guard', (context) => {
  const source = repeatedBooleanUpdates('mostPopular');
  const findings = findingsFor(context, 'drizzle-unfiltered-write', source, { ...drizzleStubs, ...notNullSchemaStub });
  assert.equal(findings.length, 3);
  assert.match(findings[0].message, /declared NOT NULL/);
  const { text, results } = applyEachFix(source, findings);
  assert.ok(
    results.every((result) => !result.error),
    JSON.stringify(results),
  );
  assert.equal(text.match(/import \{[^}]*\bne\b[^}]*\} from 'drizzle-orm'/g)?.length, 1);
  assert.equal(text.match(/\.where\(ne\(packages\.mostPopular, false\)\)/g)?.length, 3);
  assert.doesNotMatch(text, /isNull|or\(/);
});
