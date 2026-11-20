'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lint } = require('./helpers.cjs');
const { loadQueryPolicy } = require('../lib/query-policy.cjs');
const policy = {
  drizzleScopes: {
    invoices: {
      tableFrom: '@app/schema',
      field: 'tenantId',
      from: '@app/auth',
      export: 'tenant',
    },
  },
};
const files = {
  'node_modules/drizzle-orm/pg-core/db.d.ts': `
    export class Query extends Promise<unknown> {
      from(table: unknown): Query; where(clause: unknown): Query; set(data: object): Query;
      leftJoin(table: unknown, clause: unknown): Query; returning(selection?: object): Query;
      values(data: object): Query; execute(): Promise<unknown>; $dynamic(): Query;
      orderBy(column: unknown): Query; limit(count: number): Query; union(query: Query): Query;
    }
    export class Database { select(selection?: object): Query; selectDistinct(selection?: object): Query;
      update(table: unknown): Query; delete(table: unknown): Query; insert(table: unknown): Query; }`,
  'node_modules/drizzle-orm/sql/expressions/conditions.d.ts': `
    export interface BinaryOperator { (left: unknown, right: unknown): unknown }
    export declare const eq: BinaryOperator; export declare const ne: BinaryOperator;
    export declare function and(...terms: unknown[]): unknown;
    export declare function or(...terms: unknown[]): unknown;`,
  'node_modules/drizzle-orm/index.d.ts': "export * from './sql/expressions/conditions';",
  'node_modules/drizzle-orm/mock.d.ts': "export {ne as eq} from './sql/expressions/conditions';",
  'node_modules/@app/schema/index.d.ts': [
    'export declare const invoices: { id: object; tenantId: object; organizationId: object; OrganizationId: object; org_id: object };',
    'export declare const workspaces: { workspace_id: object; OR: object; "org-id": object; "جهة": object };',
    'export declare const others: typeof invoices;',
  ].join('\n'),
  'node_modules/@app/copy/index.d.ts': "export {invoices} from '@app/schema';",
  'node_modules/@app/auth/index.d.ts':
    'export declare function tenant(): string; export declare function maybeTenant(): string | undefined;',
};
const head = [
  "import type { Database } from 'drizzle-orm/pg-core/db';",
  "import {eq as equal, ne, and, or} from 'drizzle-orm';",
  "import * as operators from 'drizzle-orm';",
  "import {eq as misleading} from 'drizzle-orm/mock';",
  "import {invoices as bills, others} from '@app/schema';",
  "import * as schema from '@app/schema';",
  "import {invoices as external} from '@app/copy';",
  "import {tenant as current} from '@app/auth';",
  'async function query(db: Database, input: string, copied: typeof operators) {',
  'const tenantId = current(); const alias = bills;',
];
function flagged(lines, suppliedPolicy = policy) {
  return lint([...head, ...lines, '}'].join('\n'), files, suppliedPolicy)
    .filter((finding) => finding.ruleId === 'drizzle-scope-unverified')
    .map((finding) => finding.line - head.length);
}

test('matches distinct configured Drizzle property names on each exported table', () => {
  const base = policy.drizzleScopes.invoices;
  const custom = {
    drizzleScopes: {
      invoices: { ...base, field: 'organizationId' },
      workspaces: { ...base, field: 'workspace_id' },
    },
  };
  const source = [
    'await db.select().from(bills).where(equal(bills.organizationId, current()));',
    'await db.select().from(schema.workspaces).where(equal(schema.workspaces.workspace_id, current()));',
    'await db.select().from(bills).where(equal(bills.tenantId, current()));',
    'await db.select().from(bills).where(equal(bills.OrganizationId, current()));',
    'await db.select().from(bills).where(equal(bills.org_id, current()));',
    'await db.select().from(schema.workspaces).where(equal(bills.organizationId, current()));',
    'await db.select().from(others);',
  ];
  assert.deepEqual(flagged(source, custom), [3, 4, 5, 6]);
  assert.deepEqual(flagged(source, {}), []);
});

test('accepts quoted, Unicode and ORM-specific property names when they belong to the configured table', () => {
  for (const field of ['org-id', 'OR', 'جهة']) {
    const custom = { drizzleScopes: { workspaces: { ...policy.drizzleScopes.invoices, field } } };
    const key = JSON.stringify(field);
    assert.deepEqual(
      flagged(
        [
          'await db.select().from(schema.workspaces).where(equal(schema.workspaces[' + key + '], current()));',
          'await db.update(schema.workspaces).set({' +
            key +
            ':current()}).where(equal(schema.workspaces[' +
            key +
            '], current()));',
          'await db.select().from(schema.workspaces).where(equal(schema.workspaces[' + key + '], input));',
          'await db.select().from(schema.workspaces).where(equal(schema.workspaces.workspace_id, current()));',
        ],
        custom,
      ),
      [3, 4],
    );
  }
});

test('accepts scoped direct reads and scalar writes on the exact configured table import', () => {
  assert.deepEqual(
    flagged([
      'await db.select().from(bills).where(equal(bills.tenantId, current()));',
      'await db.select({invoice: alias.id}).from(alias).where(and(equal(schema.invoices.tenantId, tenantId), ne(bills.id, 2)));',
      'await db.select().from(schema.invoices).where(or(equal(bills.tenantId, tenantId), and(equal(alias.tenantId, current()), ne(bills.id, 7))));',
      'db.update(bills).set({tenantId, paid: true}).where(operators.eq(bills.tenantId, tenantId)).execute();',
      'await db.delete(bills).where(equal(bills.tenantId, tenantId)).returning({key:bills.id});',
      'await db.select().from(others); await db.select().from(external);',
      'db.delete(bills).where(ne(bills.id, input));',
      'await db.select().from(bills).where(equal(bills.tenantId, current())).orderBy(bills.id).limit(4);',
    ]),
    [],
  );
});

test('requires genuine Drizzle equality, an authorized scalar and a scope in every OR arm', () => {
  const cases = [
    'await db.select().from(bills);',
    'await db.select().from(bills).where(equal(bills.tenantId, input));',
    'await db.select().from(bills).where(equal(bills.tenantId, bills.tenantId));',
    'await db.select().from(bills).where(ne(bills.tenantId, current()));',
    'await db.select().from(bills).where(misleading(bills.tenantId, current()));',
    'await db.select().from(bills).where(copied.eq(bills.tenantId, current()));',
    'await db.select().from(bills).where(equal(others.tenantId, current()));',
    'await db.select().from(bills).where(equal(bills.id, current()));',
    'await db.select().from(bills).where(or(equal(bills.tenantId, current()), equal(bills.id, input)));',
    'await db.select().from(bills).where(and());',
    'await db.delete(bills).where(equal(bills.tenantId, undefined));',
    'await db.select().from(bills).where(or());',
    'await db.select().from(bills).where(and(equal(bills.tenantId,current()), copied.eq(bills.id, input)));',
    'await db.select().from(bills).where(equal(bills.tenantId, current())).$dynamic().where(equal(bills.id, input));',
    '{const equal = (_left: unknown, _right: unknown) => true; await db.select().from(bills).where(equal(bills.tenantId, current()));}',
  ];
  assert.deepEqual(
    flagged(cases),
    cases.map((line, index) => index + 1),
  );
});

test('satisfies preserves the checked predicate and does not turn request data into a trusted scope', () => {
  assert.deepEqual(
    flagged([
      'await db.select().from(bills).where((equal(bills.tenantId, current()) satisfies unknown));',
      'await db.delete(bills).where((equal(bills.tenantId, input) satisfies unknown));',
      'await db.update(bills).set(({tenantId:input} satisfies object)).where(equal(bills.tenantId,current()));',
      'await db.update(bills).set(({tenantId} satisfies object)).where(equal(bills.tenantId,current()));',
    ]),
    [2, 3],
  );
});

test('marks writes with uncertain data and composite query shapes for review', () => {
  const cases = [
    'await db.update(bills).set({tenantId:input}).where(equal(bills.tenantId, current()));',
    'await db.update(bills).set({tenantId:{set:current()}}).where(equal(bills.tenantId,current()));',
    'await db.update(bills).set({tenantId,...{name:"changed"}}).where(equal(bills.tenantId,current()));',
    'await db.insert(bills).values({tenantId});',
    'await db.select().from(others).leftJoin(bills, equal(others.id, bills.id));',
    'await db.select().from(bills).leftJoin(others, equal(others.id,bills.id)).where(equal(bills.tenantId,current()));',
    'await db.select({ calculated: input }).from(bills).where(equal(bills.tenantId,current()));',
    'await db.selectDistinct().from(bills).where(equal(bills.tenantId,current()));',
    'await db.delete(bills).where(equal(bills.tenantId,current())).returning({source:others.id});',
    'await db.select().from(bills).where(equal(bills.tenantId,current())).orderBy(input);',
  ];
  assert.deepEqual(
    flagged(cases),
    cases.map((line, index) => index + 1),
  );
  assert.deepEqual(flagged(['await db.select().from(bills);'], {}), []);
});

test('checks direct async returns and routes a protected union for review', () => {
  assert.deepEqual(
    flagged([
      'async function load() { return db.select().from(bills); }',
      'const loadArrow = async () => db.select().from(bills);',
      'function build() { return db.select().from(bills); }',
      'async function* delayed() { return db.select().from(bills); }',
      'await db.select().from(bills).where(equal(bills.tenantId,current())).union(db.select().from(others));',
      'async function scoped() { return db.select().from(bills).where(equal(bills.tenantId,current())); }',
    ]),
    [1, 2, 5],
  );
});

test('validates the configured table and trusted module specifiers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-drizzle-policy-'));
  const filename = path.join(directory, 'policy.json');
  const scope = policy.drizzleScopes.invoices;
  try {
    fs.writeFileSync(filename, JSON.stringify(policy));
    assert.deepEqual(loadQueryPolicy(filename), policy);
    for (const field of ['org-id', 'جهة', 'AND', 'OR', 'NOT']) {
      const custom = { drizzleScopes: { invoices: { ...scope, field } } };
      fs.writeFileSync(filename, JSON.stringify(custom));
      assert.deepEqual(loadQueryPolicy(filename), custom);
    }
    for (const invalid of [
      null,
      {},
      { invoices: { ...scope, tableFrom: './schema' } },
      { invoices: { ...scope, tableFrom: undefined } },
      { invoices: { ...scope, table: 'unexpected' } },
    ]) {
      fs.writeFileSync(filename, JSON.stringify({ drizzleScopes: invalid }));
      assert.throws(() => loadQueryPolicy(filename), TypeError);
    }
  } finally {
    fs.unlinkSync(filename);
    fs.rmdirSync(directory);
  }
});
