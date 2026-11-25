import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lint } from './helpers.js';
import { loadQueryPolicy } from '../../lib/performance/query-policy.js';
import type { RulePolicy } from '../../lib/shared/types.js';

const scope = { field: 'tenantId', from: '@app/auth', export: 'requireAuthorizedTenantId' };
const policy = { prismaScopes: { Invoice: scope } };
const operations = [
  'findMany',
  'findUnique',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
  'findRaw',
];
const files = {
  'node_modules/.prisma/client/index.d.ts': [
    'type Options = { where?: unknown, data?: unknown, create?: unknown, update?: unknown, include?: unknown,',
    '  select?: { id?: boolean, tenantId?: boolean, items?: boolean | { where?: unknown } } };',
    'export interface InvoiceDelegate {',
    ...operations.map((name) => name + '(options?: Options): Promise<unknown>;'),
    '}',
    'export interface OtherDelegate { findMany(options?: Options): Promise<unknown> }',
    'export interface WorkspaceDelegate { findMany(options?: Options): Promise<unknown> }',
    'export declare class PrismaClient { invoice: InvoiceDelegate; other: OtherDelegate; workspace: WorkspaceDelegate }',
  ].join('\n'),
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/@app/auth/index.d.ts': [
    'export function requireAuthorizedTenantId(): string;',
    'export function requireAuthorizedTenantId(mode: 1): string | undefined;',
    'export function requireAuthorizedTenantId(mode: 2): Promise<string>;',
    'export function requireOrganizationId(): string; export function requireWorkspaceId(): string;',
    'type ScopedId = string & { readonly scopeBrand: unique symbol };',
    'export function brandedOrg(): ScopedId; export function brandedOrg(optional: true): ScopedId | undefined;',
  ].join('\n'),
};

const header = [
  "import { PrismaClient } from '@prisma/client';",
  "import { requireAuthorizedTenantId as trusted } from '@app/auth';",
  "import * as auth from '@app/auth';",
  'const db = new PrismaClient();',
  'async function handler(input: { tenant: string }) {',
  '  const tenantId = trusted();',
];
function flagged(lines: string[], config: RulePolicy = policy) {
  return lint([...header, ...lines, '}'].join('\n'), files, config)
    .filter((record) => record.ruleId === 'prisma-scope-unverified')
    .map((record) => record.line - header.length);
}

test('matches each Prisma model’s configured scalar field and trusted function by exact name', () => {
  const custom = {
    prismaScopes: {
      Invoice: { ...scope, field: 'organizationId', export: 'requireOrganizationId' },
      Workspace: { ...scope, field: 'workspace_id', export: 'requireWorkspaceId' },
    },
  };
  const source = [
    'const organizationId = auth.requireOrganizationId(); const workspace_id = auth.requireWorkspaceId();',
    'db.invoice.findMany({where:{organizationId}});',
    'db.workspace.findMany({where:{workspace_id}});',
    'db.invoice.create({data:{organizationId}});',
    'db.invoice.update({where:{organizationId},data:{organizationId}});',
    'db.invoice.findMany({where:{tenantId:organizationId}});',
    'db.invoice.findMany({where:{OrganizationId:organizationId}});',
    'db.workspace.findMany({where:{organizationId}});',
    'db.workspace.findMany({where:{workspace_id:organizationId}});',
    'db.invoice.create({data:{tenantId:organizationId}});',
    'db.other.findMany({});',
  ];
  assert.deepEqual(flagged(source, custom), [6, 7, 8, 9, 10]);
  assert.deepEqual(flagged(source, {}), []);
});

test('proves explicit scalar scope and positive branch conditions on real delegate types', () => {
  assert.deepEqual(
    flagged([
      'const alias = tenantId;',
      'const asynchronous = await auth.requireAuthorizedTenantId(2);',
      'db.invoice.findMany({ where: { tenantId } });',
      'db.invoice.count({ where: { tenantId: { equals: alias } } });',
      'db.invoice.groupBy({ where: { OR: [{tenantId}, {AND: [{id: 9}, {tenantId: asynchronous}]}] } });',
      'db.invoice.findUnique({ where: { id: 4, tenantId }, select: { id: true } });',
      'db.invoice["findMany"]({ where: { tenantId: trusted() } });',
      'db.invoice.findMany({ where: { tenantId } }).then(() => 1);',
      'db.other.findMany({});',
      '({findMany() {}}).findMany();',
    ]),
    [],
  );
});

test('branded scalar IDs and satisfies annotations retain their original provenance', () => {
  const configured = { prismaScopes: { Invoice: { ...scope, export: 'brandedOrg' } } };
  assert.deepEqual(
    flagged(
      [
        'const id = auth.brandedOrg() satisfies string;',
        'db.invoice.findMany(({ where: { tenantId: (id satisfies string) } } satisfies object));',
        'db.invoice.create({ data: ({ tenantId: id } satisfies object) });',
        'db.invoice.findMany({ where: { tenantId: (input.tenant satisfies string) } });',
        'db.invoice.findMany({ where: { tenantId: auth.brandedOrg(true) } });',
        'db.invoice.findMany({ where: { tenantId: (auth.brandedOrg(true) as string) satisfies string } });',
      ],
      configured,
    ),
    [4, 5, 6],
  );
});

test('only static promise method names are known to preserve the scoped query', () => {
  assert.deepEqual(
    flagged([
      'const then = "items";',
      'db.invoice.findMany({ where: { tenantId } })[then]();',
      'db.invoice.findMany({ where: { tenantId } })["then"](() => {});',
    ]),
    [2],
  );
});

test('marks absent, unverifiable or non-positive proof for review', () => {
  const cases = [
    'db.invoice.findMany();',
    'db.invoice.findMany({ where: { tenantId: input.tenant } });',
    'db.invoice.count({ where: { tenantId: null } });',
    'db.invoice.aggregate({ where: { tenantId: undefined } });',
    'db.invoice.findMany({ where: { OR: [{tenantId}, {id: 4}] } });',
    'db.invoice.deleteMany({ where: { NOT: {tenantId} } });',
    'db.invoice.findMany({ where: { tenantId, ...input } });',
    'db.invoice.findMany({ where: { tenantId: trusted(1) } });',
    'db.invoice.findMany({ where: { tenantId: trusted(2) } });',
    'db.invoice.findMany({ where: { tenantId: { equals: tenantId, mode: "insensitive" } } });',
    'db.invoice.findMany({ where: { tenantId }, include: { items: true } });',
    'db.invoice.findMany({ where: { tenantId }, select: { items: true } });',
    'db.invoice.findRaw({ where: { tenantId } });',
    '{ const trusted = () => input.tenant; db.invoice.findMany({where: {tenantId: trusted()}}); }',
    '{ let local = trusted(); db.invoice.findMany({where: {tenantId: local}}); }',
    '{ const options = { where: { tenantId } }; db.invoice.findMany(options); }',
    'db.invoice["findMany"]({});',
    '{ const operation: string = "findMany"; db.invoice[operation]({where:{tenantId}}); }',
    'db.invoice.findUnique({ where: { tenantId } }).items();',
  ];
  assert.deepEqual(
    flagged(cases),
    cases.map((line, index) => index + 1),
  );
});

test('checks all write branches, scoped updates and each item in a bulk create', () => {
  assert.deepEqual(
    flagged([
      'db.invoice.create({ data: { tenantId, label: "new" } });',
      'db.invoice.createMany({ data: [{ tenantId }, { tenantId: trusted() }] });',
      'db.invoice.update({ where: { id: 1, tenantId }, data: { label: "paid" } });',
      'db.invoice.updateManyAndReturn({ where: { tenantId }, data: { tenantId: { set: trusted() } } });',
      'db.invoice.upsert({ where: { tenantId }, create: { tenantId }, update: { label: "paid" } });',
      'db.invoice.delete({ where: { id: 1, tenantId } });',
      'db.invoice.updateMany({ where: { tenantId }, data: { tenantId: input.tenant } });',
      'db.invoice.createManyAndReturn({ data: [{ tenantId }, { label: "new" }] });',
      'db.invoice.upsert({ where: { tenantId }, create: { tenantId }, update: { owner: { connect: { id: 2 } } } });',
      'db.invoice.deleteMany({});',
      'db.invoice.create({ data: { tenantId, ...input } });',
      'db.invoice.updateMany({ where: {}, data: { tenantId } });',
    ]),
    [7, 8, 9, 10, 11, 12],
  );
});

test('requires an explicit policy and rejects ambiguous configurations', () => {
  assert.deepEqual(flagged(['db.invoice.findMany();'], {}), []);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-policy-'));
  const filename = path.join(directory, 'policy.json');
  try {
    fs.writeFileSync(filename, JSON.stringify(policy));
    assert.deepEqual(loadQueryPolicy(filename), policy);
    const distinctScopes = { Invoice: scope, Workspace: scope };
    fs.writeFileSync(filename, JSON.stringify({ prismaScopes: distinctScopes }));
    assert.deepEqual(loadQueryPolicy(filename).prismaScopes, distinctScopes);
    const tablePolicy = { ...scope, tableFrom: '@app/schema', field: 'org"}:id' };
    fs.writeFileSync(filename, JSON.stringify({ drizzleScopes: { invoices: tablePolicy } }));
    const { drizzleScopes } = loadQueryPolicy(filename);
    assert.ok(drizzleScopes);
    assert.deepEqual(drizzleScopes.invoices, tablePolicy);
    const serializedScope = JSON.stringify(scope);
    for (const duplicate of [
      '{"prismaScopes":{"Invoice":' + serializedScope + '},"prismaScopes":{"Workspace":' + serializedScope + '}}',
      '{"prismaScopes":{"Invoice":{"field":"old","\\u0066ield":"new","from":"@app/auth","export":"readId"}}}',
    ]) {
      fs.writeFileSync(filename, duplicate);
      assert.throws(() => loadQueryPolicy(filename), /Duplicate query policy key/);
    }
    for (const from of ['@/auth', '#auth/session']) {
      const configured = { prismaScopes: { Invoice: { ...scope, from } } };
      fs.writeFileSync(filename, JSON.stringify(configured));
      assert.deepEqual(loadQueryPolicy(filename), configured);
    }
    for (const logical of ['AND', 'OR', 'NOT']) {
      fs.writeFileSync(filename, JSON.stringify({ prismaScopes: { Invoice: { ...scope, field: logical } } }));
      assert.throws(() => loadQueryPolicy(filename), /logical filters/);
    }
    for (const invalid of [
      {},
      { prismaScopes: {} },
      { unexpected: true, ...policy },
      { prismaScopes: { Invoice: { ...scope, typo: true } } },
      { prismaScopes: { Invoice: { ...scope, from: './auth' } } },
    ]) {
      fs.writeFileSync(filename, JSON.stringify(invalid));
      assert.throws(() => loadQueryPolicy(filename), TypeError);
    }
  } finally {
    fs.unlinkSync(filename);
    fs.rmdirSync(directory);
  }
});
