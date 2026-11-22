'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanWithFixes, onlyChange, assertReportedWithoutFix } = require('./site-fix-helpers.cjs');
const { attachSiteFixes } = require('../../lib/performance/site-fix.cjs');
const { checkRedundantSchemaIndexes } = require('../../lib/performance/redundant-indexes.cjs');
const drizzleStubs = require('./fixtures/schema/orm-stubs.cjs').drizzle;

function fixesFor(context, files, source, ruleId) {
  const { findings } = scanWithFixes(context, { ...files, 'src/service.ts': source });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function only(findings) {
  assert.equal(findings.length, 1, 'expected one finding');
  assert.equal(findings[0].fix?.requiresReview, true);
  assert.ok(findings[0].fix.note);
  return onlyChange(findings[0]);
}

// --- orm-cartesian-include -----------------------------------------------------------------------------------------

const ormFiles = {
  'node_modules/typeorm/index.d.ts': `export declare class SelectQueryBuilder<T> {
  leftJoinAndSelect(property: string, alias: string): this;
  getMany(): Promise<T[]>;
}
export declare class Repository<T> {
  createQueryBuilder(alias: string): SelectQueryBuilder<T>;
  find(options?: object): Promise<T[]>;
}`,
  'node_modules/sequelize/index.d.ts': `export declare abstract class Model {
  static findAll(options?: object): Promise<Model[]>;
  static hasMany(target: unknown, options?: object): void;
  static belongsToMany(target: unknown, options?: object): void;
}`,
};
const ormHeader = `import { Repository } from 'typeorm';
import { Model } from 'sequelize';
class Tag { id!: number; }
class Post { id!: number; }
class Profile { id!: number; }
class User { id!: number; posts!: Post[]; tags!: Tag[]; profile!: Profile; }
declare const users: Repository<User>;
class Author extends Model { posts!: Post[]; tags!: Tag[]; profile!: Profile; }
`;
const cartesian = 'orm-cartesian-include';

test('TypeORM find with two collection relations loads them with the query strategy', (context) => {
  const findings = fixesFor(
    context,
    ormFiles,
    `${ormHeader}export const run = () => users.find({ relations: ['posts', 'tags'] });`,
    cartesian,
  );
  assert.deepEqual(only(findings), {
    before: "export const run = () => users.find({ relations: ['posts', 'tags'] });",
    after: "export const run = () => users.find({ relations: ['posts', 'tags'], relationLoadStrategy: 'query' });",
  });
});

test('TypeORM query builder joins and a join strategy stay manual', (context) => {
  const findings = fixesFor(
    context,
    ormFiles,
    `${ormHeader}export const a = () => users.createQueryBuilder('user')
  .leftJoinAndSelect('user.posts', 'post')
  .leftJoinAndSelect('user.tags', 'tag')
  .getMany();
export const b = () => users.find({ relations: ['posts', 'tags'], relationLoadStrategy: 'join' });`,
    cartesian,
  );
  assertReportedWithoutFix(findings);
});

test('Sequelize: hasMany includes after the first become separate, a bare model becomes an object', (context) => {
  const findings = fixesFor(
    context,
    ormFiles,
    `${ormHeader}Author.hasMany(Post);
Author.hasMany(Tag);
export const a = () => Author.findAll({ include: [{ model: Post }, Tag] });
export const b = () => Author.findAll({ include: [Post, { model: Tag, required: false }] });`,
    cartesian,
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(onlyChange(findings[0]), {
    before: 'export const a = () => Author.findAll({ include: [{ model: Post }, Tag] });',
    after: 'export const a = () => Author.findAll({ include: [{ model: Post }, { model: Tag, separate: true }] });',
  });
  assert.deepEqual(onlyChange(findings[1]), {
    before: 'export const b = () => Author.findAll({ include: [Post, { model: Tag, required: false }] });',
    after:
      'export const b = () => Author.findAll({ include: [Post, { model: Tag, required: false, separate: true }] });',
  });
});

test('Sequelize: a belongsToMany or an undeclared association stays manual', (context) => {
  const findings = fixesFor(
    context,
    ormFiles,
    `${ormHeader}Author.hasMany(Post);
Author.belongsToMany(Tag);
export const a = () => Author.findAll({ include: [{ model: Post }, { model: Tag }] });`,
    cartesian,
  );
  assertReportedWithoutFix(findings);
});

// --- redis-incr-then-expire ----------------------------------------------------------------------------------------

const redisTypes = `
export interface ChainableCommander {
  incr(key: string): ChainableCommander;
  expire(key: string, seconds: number): ChainableCommander;
  exec(): Promise<[Error | null, unknown][] | null>;
}
export class Redis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  multi(): ChainableCommander;
}`;
const redisFiles = {
  'node_modules/ioredis/index.d.ts': redisTypes,
  'node_modules/redis/index.d.ts': redisTypes.replace('class Redis', 'class RedisClient'),
};
const incrThenExpire = 'redis-incr-then-expire';

test('an unused increment and its expire become one MULTI', (context) => {
  const findings = fixesFor(
    context,
    redisFiles,
    `import { Redis } from 'ioredis';
export async function hit(redis: Redis, key: string) {
  await redis.incr(key);
  await redis.expire(key, 60);
}`,
    incrThenExpire,
  );
  assert.deepEqual(only(findings), {
    before: 'await redis.incr(key);\nawait redis.expire(key, 60);',
    after: 'await redis.multi().incr(key).expire(key, 60).exec();',
  });
});

test('an assigned ioredis counter reads its value from the exec reply', (context) => {
  const findings = fixesFor(
    context,
    redisFiles,
    `import { Redis } from 'ioredis';
export async function hit(redis: Redis, key: string) {
  const count = await redis.incr(key);
  await redis.expire(key, 60);
  return count;
}`,
    incrThenExpire,
  );
  assert.deepEqual(only(findings), {
    before: 'const count = await redis.incr(key);\nawait redis.expire(key, 60);',
    after: 'const [[, count]] = await redis.multi().incr(key).expire(key, 60).exec();',
  });
});

test('an assigned node-redis counter and a gated expire stay manual', (context) => {
  const findings = fixesFor(
    context,
    redisFiles,
    `import { RedisClient } from 'redis';
export async function hit(redis: RedisClient, key: string) {
  const count = await redis.incr(key);
  await redis.expire(key, 60);
  return count;
}
export async function gated(redis: RedisClient, key: string) {
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, 60_000);
  return count;
}`,
    incrThenExpire,
  );
  assert.equal(findings.length, 2);
  assertReportedWithoutFix(findings);
});

// --- index-redundant-prefix ----------------------------------------------------------------------------------------

const redundantPrefix = 'index-redundant-prefix';

function drizzleSource(extras) {
  return `import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core';
export const orders = pgTable(
  'orders',
  { tenantId: uuid(), status: text() },
  ${extras},
);
`;
}

test('Drizzle: the shorter index is removed from the array form', (context) => {
  const findings = fixesFor(
    context,
    drizzleStubs,
    drizzleSource(`(table) => [
    index('a_idx').on(table.tenantId),
    index('ab_idx').on(table.tenantId, table.status),
  ]`),
    redundantPrefix,
  );
  assert.deepEqual(only(findings), { before: "index('a_idx').on(table.tenantId),", after: '' });
});

test('Drizzle: the shorter index is removed from the object form', (context) => {
  const findings = fixesFor(
    context,
    drizzleStubs,
    drizzleSource(`(table) => ({
    ab: index('ab_idx').on(table.tenantId, table.status),
    a: index('a_idx').on(table.tenantId),
  })`),
    redundantPrefix,
  );
  assert.deepEqual(only(findings), { before: "a: index('a_idx').on(table.tenantId),", after: '' });
});

function withProject(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-shapes-fix-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"pg":"8.0.0"}}');
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

function schemaFindingsWithFixes(root) {
  const findings = checkRedundantSchemaIndexes(root);
  attachSiteFixes(findings, { comments: false });
  return findings;
}

test('Prisma: the shorter @@index line is deleted', (context) => {
  const root = withProject(context, {
    'prisma/schema.prisma': `datasource db {
  provider = "postgresql"
}

model Order {
  id       String @id
  tenantId String
  status   String
  @@index([tenantId])
  @@index([tenantId, status])
}
`,
  });
  assert.deepEqual(only(schemaFindingsWithFixes(root)), { before: '@@index([tenantId])', after: '' });
});

test('SQL migrations: a redundant index stays manual', (context) => {
  const root = withProject(context, {
    'migrations/001_init.sql': `CREATE TABLE orders (id int primary key, tenant_id int, status text);
CREATE INDEX a_idx ON orders (tenant_id);
CREATE INDEX ab_idx ON orders (tenant_id, status);
`,
  });
  assertReportedWithoutFix(schemaFindingsWithFixes(root).filter((finding) => finding.ruleId === redundantPrefix));
});

// --- retry-without-backoff -----------------------------------------------------------------------------------------

const retryFiles = {
  'node_modules/axios-retry/index.d.ts': `
declare function axiosRetry(client: object, options?: { retries?: number; retryDelay?: (count: number) => number }): void;
declare namespace axiosRetry { function exponentialDelay(count: number): number }
export default axiosRetry;`,
};
const retryWithoutBackoff = 'retry-without-backoff';
const backoff = 'await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100 + Math.random() * 100));';

test('a counted retry loop whose catch only logs waits with backoff at the end of the catch', (context) => {
  const findings = fixesFor(
    context,
    retryFiles,
    `export async function load(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      console.warn(error);
    }
  }
}`,
    retryWithoutBackoff,
  );
  assert.deepEqual(only(findings), { before: 'console.warn(error);', after: `console.warn(error);\n${backoff}` });
});

test('an empty catch and one ending in continue get the wait too', (context) => {
  const findings = fixesFor(
    context,
    retryFiles,
    `export async function load(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url);
    } catch {}
  }
}
export async function again(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url);
    } catch {
      continue;
    }
  }
}`,
    retryWithoutBackoff,
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(onlyChange(findings[0]), { before: '} catch {}', after: `} catch { ${backoff} }` });
  assert.deepEqual(onlyChange(findings[1]), { before: 'continue;', after: `${backoff}\ncontinue;` });
});

test('while loops and catches that do more than log stay manual', (context) => {
  const findings = fixesFor(
    context,
    retryFiles,
    `declare function record(error: unknown): void;
export async function a(url: string) {
  while (true) { try { return await fetch(url); } catch (error) { console.warn(error); } }
}
export async function b(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch(url); } catch (error) { record(error); }
  }
}`,
    retryWithoutBackoff,
  );
  assert.equal(findings.length, 2);
  assertReportedWithoutFix(findings);
});

test('axios-retry gets the exponential delay of its default import', (context) => {
  const findings = fixesFor(
    context,
    retryFiles,
    `import retry from 'axios-retry';
declare const client: object;
retry(client, { retries: 3 });
retry(client);`,
    retryWithoutBackoff,
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(onlyChange(findings[0]), {
    before: 'retry(client, { retries: 3 });',
    after: 'retry(client, { retries: 3, retryDelay: retry.exponentialDelay });',
  });
  assert.deepEqual(onlyChange(findings[1]), {
    before: 'retry(client);',
    after: 'retry(client, { retryDelay: retry.exponentialDelay });',
  });
});
