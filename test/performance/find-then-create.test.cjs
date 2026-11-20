'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { projects, projectFiles } = require('./index-rules-fixtures.cjs');
const { scanWithFixes } = require('./site-fix-helpers.cjs');

const rule = 'find-then-create-race';

function delegate(model) {
  return `export interface ${model}Delegate {
  findFirst(args?: object): Promise<any>;
  findUnique(args?: object): Promise<any>;
  create(args: object): Promise<any>;
  upsert(args: object): Promise<any>;
}`;
}
const prismaClient = `${['User', 'Product'].map(delegate).join('\n')}
export declare class PrismaClient {
  user: UserDelegate; product: ProductDelegate;
  $transaction<T>(work: (tx: PrismaClient) => Promise<T>, options?: object): Promise<T>;
}`;

// The fixture project owns a schema.prisma: User.email is unique, Product is unique on (storeId, sku).
function withSchema(body) {
  const source = `import { PrismaClient } from '${projects.prisma}node_modules/.prisma/client';\ndeclare const prisma: PrismaClient;\n${body}`;
  const files = projectFiles('prisma', { 'node_modules/.prisma/client/index.d.ts': prismaClient });
  return lint(source, files).filter((finding) => finding.ruleId === rule);
}

function withoutSchema(body) {
  const source = `import { PrismaClient } from '@prisma/client';\ndeclare const prisma: PrismaClient;\n${body}`;
  return lint(source, { 'node_modules/@prisma/client/index.d.ts': prismaClient }).filter(
    (finding) => finding.ruleId === rule,
  );
}

const findThenCreate = (key, lookup = 'findFirst') => `export async function register(${key}: string) {
  const existing = await prisma.user.${lookup}({ where: { ${key} } });
  if (existing) throw new Error('taken');
  return prisma.user.create({ data: { ${key}, role: 'CUSTOMER' } });
}`;

test('Prisma: a lookup then create on a key with no unique constraint is reported', () => {
  const [finding] = withSchema(findThenCreate('name'));
  assert.equal(finding.line, 6);
  assert.equal(finding.contextualReason, undefined);
  assert.match(finding.message, /^`findFirst` looks for `name` and `create` inserts when nothing is found/);
  assert.match(finding.message, /P2002/);
});

test('Prisma: a unique column, a composite unique key and a primary key are quiet', () => {
  assert.deepEqual(withSchema(findThenCreate('email')), []);
  assert.deepEqual(withSchema(findThenCreate('email', 'findUnique')), []);
  assert.deepEqual(
    withSchema(`export async function add(storeId: string, sku: string) {
  const found = await prisma.product.findFirst({ where: { storeId, sku } });
  if (!found) await prisma.product.create({ data: { storeId, sku, name: 'x', description: '', priceEGP: 1 } });
}`),
    [],
  );
});

test('Prisma: part of a composite unique key is not enough', () => {
  const findings = withSchema(`export async function add(sku: string) {
  const found = await prisma.product.findFirst({ where: { sku } });
  if (!found) await prisma.product.create({ data: { sku } });
}`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /looks for `sku`/);
});

test('Prisma: without a schema the finding is contextual', () => {
  const [finding] = withoutSchema(findThenCreate('email'));
  assert.ok(finding);
  assert.match(finding.contextualReason, /schema is not available/);
});

test('Prisma: the create may sit in the if, after a guard that exits or behind a negated check', () => {
  const guarded = (statements) => `export async function run(name: string) {\n${statements}\n}`;
  assert.equal(
    withSchema(
      guarded(`  const found = await prisma.user.findFirst({ where: { name } });
  if (!found) {
    await prisma.user.create({ data: { name } });
  }`),
    ).length,
    1,
  );
  assert.equal(
    withSchema(
      guarded(`  const found = await prisma.user.findFirst({ where: { name } });
  if (found) return found;
  return prisma.user.create({ data: { name } });`),
    ).length,
    1,
  );
  assert.equal(
    withSchema(
      guarded(
        `  if (await prisma.user.findFirst({ where: { name } })) return;\n  await prisma.user.create({ data: { name } });`,
      ),
    ).length,
    1,
  );
});

test('Prisma: unrelated lookups and creates are quiet', () => {
  const guarded = (statements) => `export async function run(name: string, other: string) {\n${statements}\n}`;
  const quiet = [
    // a different key value
    `  const found = await prisma.user.findFirst({ where: { name } });\n  if (found) return;\n  await prisma.user.create({ data: { name: other } });`,
    // a different model
    `  const found = await prisma.user.findFirst({ where: { name } });\n  if (found) return;\n  await prisma.product.create({ data: { name } });`,
    // the creation does not depend on the lookup result
    `  await prisma.user.findFirst({ where: { name } });\n  await prisma.user.create({ data: { name } });`,
    // the create comes first
    `  await prisma.user.create({ data: { name } });\n  const found = await prisma.user.findFirst({ where: { name } });\n  if (found) return;`,
    // filters that are not an equality on one key
    `  const found = await prisma.user.findFirst({ where: { name: { contains: name } } });\n  if (found) return;\n  await prisma.user.create({ data: { name } });`,
    `  const found = await prisma.user.findFirst({ where: { OR: [{ name }] } });\n  if (found) return;\n  await prisma.user.create({ data: { name } });`,
    // data that spreads unknown fields
    `  const found = await prisma.user.findFirst({ where: { name } });\n  if (found) return;\n  await prisma.user.create({ data: { ...{ name } } });`,
  ];
  for (const statements of quiet) assert.deepEqual(withSchema(guarded(statements)), [], statements);
});

test('Prisma: a serializable transaction, a lock or a handled P2002 silences the rule', () => {
  const quiet = [
    `export async function run(name: string) {
  return prisma.$transaction(async (tx) => {
    const found = await tx.user.findFirst({ where: { name } });
    if (found) return found;
    return tx.user.create({ data: { name } });
  }, { isolationLevel: 'Serializable' });
}`,
    `export async function run(name: string) {
  const found = await prisma.user.findFirst({ where: { name } });
  if (found) return found;
  try {
    return await prisma.user.create({ data: { name } });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return prisma.user.findFirst({ where: { name } });
    throw error;
  }
}`,
  ];
  for (const body of quiet) assert.deepEqual(withSchema(body), [], body);
});

const typeormStub = `export class Repository<T> {
  findOne(options: object): Promise<T | null>;
  findOneBy(filter: object): Promise<T | null>;
  save(entity: object): Promise<T>;
  insert(entity: object): Promise<object>;
  create(entity: object): T;
}
export declare function Column(options?: object): PropertyDecorator;
export declare function Entity(): ClassDecorator;`;
const typeormHeader = `import { Repository, Column, Entity } from 'typeorm';
@Entity()
class Account {
  @Column() id!: number;
  @Column({ unique: true }) email!: string;
  @Column() handle!: string;
}
declare const accounts: Repository<Account>;
`;

function typeormFindings(body) {
  return lint(typeormHeader + body, { 'node_modules/typeorm/index.d.ts': typeormStub }).filter(
    (finding) => finding.ruleId === rule,
  );
}

test('TypeORM: findOneBy then save on a non-unique column is reported', () => {
  const [finding] = typeormFindings(`export async function claim(handle: string) {
  const found = await accounts.findOneBy({ handle });
  if (found) throw new Error('taken');
  return accounts.save(accounts.create({ handle }));
}`);
  assert.equal(finding.line, 12);
  assert.match(finding.message, /^`findOneBy` looks for `handle` and `save` inserts/);
});

test('TypeORM: findOne with where then insert is reported, a unique column or a lock is quiet', () => {
  assert.equal(
    typeormFindings(`export async function claim(handle: string) {
  const found = await accounts.findOne({ where: { handle } });
  if (!found) await accounts.insert({ handle });
}`).length,
    1,
  );
  assert.deepEqual(
    typeormFindings(`export async function claim(email: string) {
  const found = await accounts.findOneBy({ email });
  if (!found) await accounts.save({ email });
}`),
    [],
  );
  assert.deepEqual(
    typeormFindings(`export async function claim(handle: string) {
  const found = await accounts.findOne({ where: { handle }, lock: { mode: 'pessimistic_write' } });
  if (!found) await accounts.save({ handle });
}`),
    [],
  );
});

test('TypeORM: a saved variable the rule cannot read is quiet', () => {
  assert.deepEqual(
    typeormFindings(`export async function claim(handle: string, entity: Account) {
  const found = await accounts.findOneBy({ handle });
  if (!found) await accounts.save(entity);
}`),
    [],
  );
});

test('TypeORM: a unique expression index added by a migration silences the rule', (context) => {
  const entity = `${typeormHeader}export async function claim(handle: string) {
  const found = await accounts.findOneBy({ handle });
  if (!found) await accounts.save({ handle });
}`;
  const migration =
    'export const up = `CREATE UNIQUE INDEX "ux_account_handle" ON "account" (lower("handle")) WHERE "deleted_at" IS NULL`;';
  const findingsFor = (extra) => {
    const { findings } = scanWithFixes(context, {
      'package.json': '{"name":"fixture"}',
      'node_modules/typeorm/index.d.ts': typeormStub,
      'src/account.ts': entity,
      ...extra,
    });
    return findings.filter((finding) => finding.ruleId === rule);
  };
  assert.equal(findingsFor({}).length, 1);
  assert.deepEqual(findingsFor({ 'src/migrations/1700-add-handle.ts': migration }), []);
});
