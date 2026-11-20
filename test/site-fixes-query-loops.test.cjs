'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const prismaStub = `export interface UserDelegate {
  findMany(options?: object): Promise<{ id: number, active: boolean, score: number }[]>;
  findUnique(options: object): Promise<{ id: number } | null>;
  count(options?: object): Promise<number>;
  create(options: object): Promise<{ id: number }>;
  createMany(options: object): Promise<{ count: number }>;
  update(options: object): Promise<{ id: number }>;
}
export declare class PrismaClient { user: UserDelegate }`;
const prismaFiles = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': prismaStub,
};
const pgFiles = {
  'node_modules/@types/pg/index.d.ts': `interface PgResult { rows: { id: number, active: boolean, label: string }[] }
export class Pool { query(input: string, values?: unknown[]): Promise<PgResult>; }`,
};
const typeormFiles = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  findBy(filter: object): Promise<T[]>;
  findOneBy(filter: object): Promise<T | null>;
}
export function In(ids: unknown[]): object;`,
};
const redisFiles = {
  'node_modules/ioredis/index.d.ts': `export class Redis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<'OK'>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}`,
  'node_modules/redis/index.d.ts': `declare class RedisClient { get(key: string): Promise<string | null>; }
export type RedisClientType = RedisClient & { extra: true };`,
};

function fixesFor(context, files, source, ruleId) {
  const { findings } = scanWithFixes(context, { ...files, 'src/service.ts': source });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function only(findings) {
  assert.equal(findings.length, 1, 'expected one finding');
  return onlyChange(findings[0]);
}

const prismaHeader = `import type { PrismaClient } from '@prisma/client';
type Item = { userId: number, name: string };
declare const prisma: PrismaClient;
`;

test('a for-of of Prisma creates becomes one createMany over the same rows', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function save(items: Item[]) {
  for (const item of items) {
    await prisma.user.create({ data: { name: item.name, active: true } });
  }
}`,
    'prisma-query-in-loop',
  );
  assert.deepEqual(only(findings), {
    before: `for (const item of items) {
  await prisma.user.create({ data: { name: item.name, active: true } });
}`,
    after: 'await prisma.user.createMany({ data: items.map((item) => ({ name: item.name, active: true })) });',
  });
  assert.match(findings[0].fix.note, /count/);
});

test('Promise.all over mapped Prisma creates becomes one createMany', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function save(items: Item[]) {
  await Promise.all(items.map((item) => prisma.user.create({ data: { name: item.name } })));
}`,
    'prisma-query-in-loop',
  );
  assert.deepEqual(only(findings), {
    before: 'await Promise.all(items.map((item) => prisma.user.create({ data: { name: item.name } })));',
    after: 'await prisma.user.createMany({ data: items.map((item) => ({ name: item.name })) });',
  });
});

test('creates with nested relation writes, a used result or other loop work keep the generic advice', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function save(items: Item[]) {
  for (const item of items) {
    await prisma.user.create({ data: { name: item.name, team: { connect: { id: 1 } } } });
  }
  for (const item of items) {
    const created = await prisma.user.create({ data: { name: item.name } });
    console.log(created);
  }
  for (const item of items) {
    console.log(item);
    await prisma.user.create({ data: { name: item.name } });
  }
  const results = await Promise.all(items.map((item) => prisma.user.create({ data: { name: item.name } })));
  return results;
}`,
    'prisma-query-in-loop',
  );
  assert.equal(findings.length, 4);
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    [undefined, undefined, undefined, undefined],
  );
});

test('a findUnique by key in a loop becomes one findMany indexed in a Map', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function load(items: Item[]) {
  const names = [];
  for (const item of items) {
    const user = await prisma.user.findUnique({ where: { id: item.userId } });
    names.push(user?.id);
  }
  return names;
}`,
    'prisma-query-in-loop',
  );
  assert.deepEqual(only(findings), {
    before: `for (const item of items) {
  const user = await prisma.user.findUnique({ where: { id: item.userId } });`,
    after: `const users = await prisma.user.findMany({ where: { id: { in: items.map((item) => item.userId) } } });
const usersById = new Map(users.map((user) => [user.id, user] as const));
for (const item of items) {
  const user = usersById.get(item.userId) ?? null;`,
  });
});

test('a lookup keyed by the loop variable passes the collection itself', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function load(ids: number[], seen: unknown[]) {
  for (const id of ids) {
    seen.push(await prisma.user.findUnique({ where: { id }, select: { id: true } }));
  }
}`,
    'prisma-query-in-loop',
  );
  assert.deepEqual(only(findings), {
    before: `for (const id of ids) {
  seen.push(await prisma.user.findUnique({ where: { id }, select: { id: true } }));`,
    after: `const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
const usersById = new Map(users.map((user) => [user.id, user] as const));
for (const id of ids) {
  seen.push(usersById.get(id) ?? null);`,
  });
});

test('dependent, conditional and previous-iteration lookups are not batched', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function load(items: Item[]) {
  let previous = 0;
  for (const item of items) {
    const user = await prisma.user.findUnique({ where: { id: previous } });
    previous = item.userId + (user?.id ?? 0);
  }
  for (const item of items) {
    const user = await prisma.user.findUnique({ where: { id: item.userId } });
    await prisma.user.update({ where: { id: item.userId }, data: { active: !user } });
  }
  for (const item of items) {
    if (!item.userId) continue;
    const user = await prisma.user.findUnique({ where: { id: item.userId } });
    console.log(user);
  }
  for (const item of items) {
    const user = await prisma.user.findUnique({ where: { id: item.userId, active: true } });
    console.log(user);
  }
}`,
    'prisma-query-in-loop',
  );
  const lookups = findings.filter((finding) => /findUnique/.test(finding.message));
  assert.equal(lookups.length, 4);
  assert.deepEqual(
    lookups.map((finding) => finding.fix),
    [undefined, undefined, undefined, undefined],
  );
});

test('a TypeORM findOneBy by id becomes findBy with In, added to the existing import', (context) => {
  const findings = fixesFor(
    context,
    typeormFiles,
    `import { Repository } from 'typeorm';
type Order = { userId: number };
declare const userRepository: Repository<{ id: number }>;
export async function load(orders: Order[]) {
  for (const order of orders) {
    const user = await userRepository.findOneBy({ id: order.userId });
    console.log(user);
  }
}`,
    'orm-query-in-loop',
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(
    findings[0].fix.changes.map(({ before, after }) => ({ before, after })),
    [
      { before: "import { Repository } from 'typeorm';", after: "import { Repository, In } from 'typeorm';" },
      {
        before: `  for (const order of orders) {
    const user = await userRepository.findOneBy({ id: order.userId });`,
        after: `  const users = await userRepository.findBy({ id: In(orders.map((order) => order.userId)) });
  const usersById = new Map(users.map((user) => [user.id, user] as const));
  for (const order of orders) {
    const user = usersById.get(order.userId) ?? null;`,
      },
    ],
  );
});

test('TypeORM lookups by a non-primary column are not batched', (context) => {
  const findings = fixesFor(
    context,
    typeormFiles,
    `import { Repository } from 'typeorm';
declare const repo: Repository<{ id: number }>;
export async function load(emails: string[]) {
  for (const email of emails) {
    const found = await repo.findOneBy({ email });
    console.log(found);
  }
}`,
    'orm-query-in-loop',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fix, undefined);
});

test('a pg key lookup in a loop becomes one ANY($1) query grouped by key', (context) => {
  const findings = fixesFor(
    context,
    pgFiles,
    `import type { Pool } from 'pg';
type Item = { userId: number };
export async function load(pool: Pool, items: Item[]) {
  for (const item of items) {
    const { rows } = await pool.query('SELECT id, label FROM users WHERE id = $1', [item.userId]);
    console.log(rows);
  }
}`,
    'pg-query-in-loop',
  );
  assert.deepEqual(only(findings), {
    before: `for (const item of items) {
  const { rows } = await pool.query('SELECT id, label FROM users WHERE id = $1', [item.userId]);`,
    after: `const { rows: users } = await pool.query('SELECT id, label FROM users WHERE id = ANY($1)', [items.map((item) => item.userId)]);
const usersById = new Map();
for (const row of users) usersById.set(String(row.id), [...(usersById.get(String(row.id)) ?? []), row]);
for (const item of items) {
  const rows = usersById.get(String(item.userId)) ?? [];`,
  });
});

test('pg lookups that omit the key column or filter on more than one column are not batched', (context) => {
  const findings = fixesFor(
    context,
    pgFiles,
    `import type { Pool } from 'pg';
export async function load(pool: Pool, ids: number[]) {
  for (const id of ids) {
    console.log((await pool.query('SELECT label FROM users WHERE id = $1', [id])).rows);
  }
  for (const id of ids) {
    console.log((await pool.query('SELECT * FROM users WHERE id = $1 AND active = $2', [id, true])).rows);
  }
}`,
    'pg-query-in-loop',
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    [undefined, undefined],
  );
});

test('a Redis get per item becomes one mget for ioredis and mGet for node-redis', (context) => {
  const source = (client) => `import type { Redis } from 'ioredis';
import type { RedisClientType } from 'redis';
declare const redis: ${client};
export async function load(ids: string[]) {
  for (const id of ids) {
    const cached = await redis.get(\`user:\${id}\`);
    console.log(cached);
  }
}`;
  const [ioredis] = fixesFor(context, redisFiles, source('Redis'), 'redis-command-in-loop');
  assert.deepEqual(onlyChange(ioredis), {
    before: `for (const id of ids) {
  const cached = await redis.get(\`user:\${id}\`);`,
    after: `const keys = ids.map((id) => \`user:\${id}\`);
const values = keys.length ? await redis.mget(keys) : [];
const cachedByKey = new Map(keys.map((key, index) => [key, values[index]] as const));
for (const id of ids) {
  const cached = cachedByKey.get(\`user:\${id}\`) ?? null;`,
  });
  const [nodeRedis] = fixesFor(context, redisFiles, source('RedisClientType'), 'redis-command-in-loop');
  assert.match(onlyChange(nodeRedis).after, /await redis\.mGet\(keys\)/);
});

test('a Redis key built from the previous reply is not batched', (context) => {
  const findings = fixesFor(
    context,
    redisFiles,
    `import type { Redis } from 'ioredis';
declare const redis: Redis;
export async function walk(ids: string[]) {
  let next = 'start';
  for (const id of ids) {
    next = (await redis.get(next + id)) ?? 'start';
  }
}`,
    'redis-command-in-loop',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fix, undefined);
});

test('Prisma count and first-row reads become count and findFirst', (context) => {
  const { findings } = scanWithFixes(context, {
    ...prismaFiles,
    'src/service.ts': `${prismaHeader}export async function read() {
  const where = { active: true };
  const total = (await prisma.user.findMany({ where })).length;
  const first = (await prisma.user.findMany({ where, orderBy: { id: 'asc' } }))[0];
  const firstId = (await prisma.user.findMany({ where }))[0]?.id;
  const loose = (await prisma.user.findMany({ where }))[0];
  return [total, first?.id, firstId, loose === undefined];
}`,
  });
  const [count, first, firstId, loose] = findings.filter((finding) => finding.ruleId.startsWith('prisma-'));
  assert.equal(count.ruleId, 'prisma-count-materialization');
  assert.deepEqual(onlyChange(count), {
    before: 'const total = (await prisma.user.findMany({ where })).length;',
    after: 'const total = await prisma.user.count({ where });',
  });
  assert.deepEqual(onlyChange(first), {
    before: "const first = (await prisma.user.findMany({ where, orderBy: { id: 'asc' } }))[0];",
    after: "const first = await prisma.user.findFirst({ where, orderBy: { id: 'asc' } });",
  });
  assert.deepEqual(onlyChange(firstId), {
    before: 'const firstId = (await prisma.user.findMany({ where }))[0]?.id;',
    after: 'const firstId = (await prisma.user.findFirst({ where }))?.id;',
  });
  // `=== undefined` would see findFirst's null as a different result.
  assert.equal(loose.fix, undefined);
});

test('Prisma filter and top-K reads move the condition and order into the query', (context) => {
  const { findings } = scanWithFixes(context, {
    ...prismaFiles,
    'src/service.ts': `${prismaHeader}export async function read() {
  const inactive = (await prisma.user.findMany({ select: { active: true } })).filter((row) => row.active === false);
  const scoped = (await prisma.user.findMany({ where: { score: 1 } })).filter((row) => row.id === 7);
  const top = (await prisma.user.findMany()).sort((a, b) => b.score - a.score).slice(0, 3);
  const ordered = (await prisma.user.findMany({ orderBy: { id: 'asc' } })).sort((a, b) => a.score - b.score).slice(0, 2);
  return [inactive, scoped, top, ordered];
}`,
  });
  const [inactive, scoped, top, ordered] = findings.filter((finding) => finding.ruleId.startsWith('prisma-'));
  assert.deepEqual(onlyChange(inactive), {
    before:
      'const inactive = (await prisma.user.findMany({ select: { active: true } })).filter((row) => row.active === false);',
    after: 'const inactive = await prisma.user.findMany({ select: { active: true }, where: { active: false } });',
  });
  assert.deepEqual(onlyChange(scoped), {
    before: 'const scoped = (await prisma.user.findMany({ where: { score: 1 } })).filter((row) => row.id === 7);',
    after: 'const scoped = await prisma.user.findMany({ where: { AND: [{ score: 1 }, { id: 7 }] } });',
  });
  assert.deepEqual(onlyChange(top), {
    before: 'const top = (await prisma.user.findMany()).sort((a, b) => b.score - a.score).slice(0, 3);',
    after: "const top = await prisma.user.findMany({ orderBy: { score: 'desc' }, take: 3 });",
  });
  assert.deepEqual(onlyChange(ordered), {
    before:
      "const ordered = (await prisma.user.findMany({ orderBy: { id: 'asc' } })).sort((a, b) => a.score - b.score).slice(0, 2);",
    after: "const ordered = await prisma.user.findMany({ orderBy: [{ score: 'asc' }, { id: 'asc' }], take: 2 });",
  });
  assert.match(top.fix.note, /NULL/);
});

test('pg first-row and count reads add LIMIT 1 and count in SQL', (context) => {
  const { findings } = scanWithFixes(context, {
    ...pgFiles,
    'src/service.ts': `import type { Pool } from 'pg';
export async function read(pool: Pool) {
  const first = (await pool.query('SELECT * FROM items WHERE id > $1 ORDER BY id;', [5])).rows[0];
  const total = (await pool.query('select id from items where active = $1', [true])).rows.length;
  return [first, total];
}`,
  });
  const byRule = (ruleId) => findings.find((finding) => finding.ruleId === ruleId);
  assert.deepEqual(onlyChange(byRule('pg-first-materialization')), {
    before: "const first = (await pool.query('SELECT * FROM items WHERE id > $1 ORDER BY id;', [5])).rows[0];",
    after: "const first = (await pool.query('SELECT * FROM items WHERE id > $1 ORDER BY id LIMIT 1;', [5])).rows[0];",
  });
  assert.deepEqual(onlyChange(byRule('pg-count-materialization')), {
    before: "const total = (await pool.query('select id from items where active = $1', [true])).rows.length;",
    after:
      "const total = Number((await pool.query('select count(*) as total from items where active = $1', [true])).rows[0].total);",
  });
});
