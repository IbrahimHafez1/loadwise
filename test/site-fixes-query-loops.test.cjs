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
  findFirst(options: object): Promise<{ id: number } | null>;
  aggregate(options: object): Promise<{ _avg: { score: number | null }, _count: { _all: number } }>;
  groupBy(options: object): Promise<object[]>;
}
export declare class PrismaClient {
  user: UserDelegate;
  $transaction<T>(operations: Promise<T>[]): Promise<T[]>;
}`;
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
  find(options?: object): Promise<T[]>;
  findOne(options: object): Promise<T | null>;
  count(options?: object): Promise<number>;
  existsBy(filter: object): Promise<boolean>;
  save(entity: T): Promise<T>;
}
export class DataSource { getRepository<T>(target: unknown): Repository<T>; }
export function In(ids: unknown[]): object;
export function IsNull(): object;`,
};
const redisFiles = {
  'node_modules/ioredis/index.d.ts': `export class Redis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...options: unknown[]): Promise<'OK'>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, keys: number, ...args: unknown[]): Promise<unknown>;
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

test('creates createMany cannot run become one $transaction; a used loop result or other loop work do not', (context) => {
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
    findings.map((finding) => finding.fix?.changes.map((change) => change.after.trim())),
    [
      [
        'await prisma.$transaction(items.map((item) => prisma.user.create({ data: { name: item.name, team: { connect: { id: 1 } } } })));',
      ],
      undefined,
      undefined,
      [
        'const results = await prisma.$transaction(items.map((item) => prisma.user.create({ data: { name: item.name } })));',
      ],
    ],
  );
  assert.match(findings[0].fix.note, /one transaction/);
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

test('a lookup keyed by the previous iteration or written before it in the same iteration is not batched', (context) => {
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
    await prisma.user.update({ where: { id: item.userId }, data: { active: true } });
    const user = await prisma.user.findUnique({ where: { id: item.userId } });
    console.log(user);
  }
  for (const item of items) {
    try {
      console.log(await prisma.user.findUnique({ where: { id: item.userId } }));
    } catch {}
  }
}`,
    'prisma-query-in-loop',
  );
  const lookups = findings.filter((finding) => /findUnique/.test(finding.message));
  assert.equal(lookups.length, 3);
  assert.deepEqual(
    lookups.map((finding) => finding.fix),
    [undefined, undefined, undefined],
  );
});

test('a guarded lookup filters missing keys, keeps extra filters and adds the key to select', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function load(items: Item[]) {
  for (const item of items) {
    if (!item.userId) continue;
    const user = await prisma.user.findUnique({ where: { id: item.userId, active: true }, select: { score: true } });
    console.log(user);
  }
}`,
    'prisma-query-in-loop',
  );
  assert.deepEqual(
    findings[0].fix.changes.map((change) => change.after.trim()),
    [
      `const users = await prisma.user.findMany({ where: { id: { in: items.map((item) => item.userId).filter((key) => key != null) }, active: true }, select: { score: true, id: true } });
  const usersById = new Map(users.map((user) => [user.id, user] as const));
  for (const item of items) {
    if (!item.userId) continue;
    const user = usersById.get(item.userId) ?? null;`,
    ],
  );
  assert.match(findings[0].fix.note, /select now also reads `id`/);
});

test('a lookup before writes to the same model is batched only when the keys cannot repeat', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}declare const SEED_ITEMS: Item[];
export async function sync(items: Item[]) {
  for (const item of SEED_ITEMS) {
    const user = await prisma.user.findUnique({ where: { id: item.userId } });
    await prisma.user.update({ where: { id: item.userId }, data: { active: !user } });
  }
  for (const item of items) {
    const user = await prisma.user.findUnique({ where: { id: item.userId } });
    await prisma.user.update({ where: { id: item.userId }, data: { active: !user } });
  }
}`,
    'prisma-query-in-loop',
  );
  const [fixedList, queriedList] = findings.filter((finding) => /findUnique/.test(finding.message));
  assert.deepEqual(onlyChange(fixedList), {
    before: `for (const item of SEED_ITEMS) {
  const user = await prisma.user.findUnique({ where: { id: item.userId } });`,
    after: `const users = await prisma.user.findMany({ where: { id: { in: SEED_ITEMS.map((item) => item.userId) } } });
const usersById = new Map(users.map((user) => [user.id, user] as const));
for (const item of SEED_ITEMS) {
  const user = usersById.get(item.userId) ?? null;`,
  });
  assert.match(fixedList.fix.note, /no two items share a key/);
  // Two items of a queried list may share a key, and the second must see the first one's write.
  assert.equal(queriedList.fix, undefined);
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

test('a TypeORM lookup by a non-primary column is batched with a note about duplicate rows', (context) => {
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
  assert.equal(
    findings[0].fix.changes[0].after,
    `import { Repository, In } from 'typeorm';
declare const repo: Repository<{ id: number }>;
export async function load(emails: string[]) {
  const rows = await repo.findBy({ email: In(emails) });
  const rowsByEmail = new Map(rows.map((row) => [row.email, row] as const));
  for (const email of emails) {
    const found = rowsByEmail.get(email) ?? null;`,
  );
  assert.match(findings[0].fix.note, /several rows share a key/);
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

const typeormHeader = `import { DataSource, IsNull, Repository } from 'typeorm';
type Role = { id: number, name: string, clinicId: number | null };
`;

// The loop writes in these fixtures are reported too, but only the reads get a site fix.
function readFindings(findings) {
  return findings.filter((finding) => !/runs one write per item/.test(finding.message));
}

function afterTexts(finding) {
  return finding.fix?.changes.map((change) => change.after);
}

test('a TypeORM findOne in a seed loop over a fixed list becomes one find with In', (context) => {
  const findings = readFindings(
    fixesFor(
      context,
      typeormFiles,
      `${typeormHeader}declare const ROLES: { name: string }[];
declare const roleRepo: Repository<Role>;
export async function seed() {
  for (const roleData of ROLES) {
    const existing = await roleRepo.findOne({ where: { name: roleData.name, clinicId: IsNull() }, relations: { permissions: true } });
    if (!existing) await roleRepo.save({ id: 0, name: roleData.name, clinicId: null });
  }
}`,
      'orm-query-in-loop',
    ),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(afterTexts(findings[0]), [
    "import { DataSource, IsNull, Repository, In } from 'typeorm';",
    `  const roles = await roleRepo.find({ where: { name: In(ROLES.map((roleData) => roleData.name)), clinicId: IsNull() }, relations: { permissions: true } });
  const rolesByName = new Map(roles.map((role) => [role.name, role] as const));
  for (const roleData of ROLES) {
    const existing = rolesByName.get(roleData.name) ?? null;`,
  ]);
  assert.match(findings[0].fix.note, /the Map keeps the last one/);
  assert.match(findings[0].fix.note, /check that no two items share a key\.$/);
});

test('TypeORM lookups in a try, with a lock, after a same-repository write or over repeatable keys stay', (context) => {
  const findings = readFindings(
    fixesFor(
      context,
      typeormFiles,
      `${typeormHeader}declare const repo: Repository<Role>;
declare const other: Repository<Role>;
type Entry = { id: number, roleId: number, name: string };
export async function run(entries: Entry[]) {
  for (const entry of entries) {
    try {
      console.log(await repo.findOne({ where: { id: entry.roleId } }));
    } catch {}
  }
  for (const entry of entries) {
    console.log(await repo.findOne({ where: { id: entry.roleId }, lock: { mode: 'pessimistic_write' } }));
  }
  for (const entry of entries) {
    await repo.save({ id: entry.roleId, name: entry.name, clinicId: null });
    console.log(await repo.findOne({ where: { id: entry.roleId } }));
  }
  for (const entry of entries) {
    const live = await repo.existsBy({ name: entry.name, clinicId: IsNull() });
    if (!live) await repo.save({ id: entry.id, name: entry.name, clinicId: null });
  }
  for (const entry of entries) {
    await other.save({ id: entry.id, name: entry.name, clinicId: null });
    console.log(await repo.findOne({ where: { id: entry.id } }));
  }
}`,
      'orm-query-in-loop',
    ),
  );
  assert.equal(findings.length, 5);
  assert.deepEqual(
    findings.slice(0, 4).map((finding) => finding.fix),
    [undefined, undefined, undefined, undefined],
  );
  // A write to another repository before the read is left to the reviewer through the note.
  assert.equal(
    findings[4].fix.changes[1].after,
    `  const rows = await repo.find({ where: { id: In(entries.map((entry) => entry.id)) } });
  const rowsById = new Map(rows.map((row) => [row.id, row] as const));
  for (const entry of entries) {
    await other.save({ id: entry.id, name: entry.name, clinicId: null });
    console.log(rowsById.get(entry.id) ?? null);`,
  );
  assert.match(findings[4].fix.note, /other\.save cannot change what it reads\.$/);
});

test('a guarded TypeORM count becomes one grouped count; existsBy becomes a Set', (context) => {
  const findings = fixesFor(
    context,
    typeormFiles,
    `${typeormHeader}type Clinic = { id: number, staff: number };
declare class RoleEntity {}
export async function seed(ds: DataSource, clinics: Clinic[], repo: Repository<Role>, names: string[]) {
  for (const clinic of clinics) {
    if (clinic.staff === 0 || (await ds.getRepository<Role>(RoleEntity).count({ where: { clinicId: clinic.id } })) > 0) continue;
    console.log(clinic);
  }
  for (const name of names) {
    const known = await repo.existsBy({ name, clinicId: IsNull() });
    console.log(known);
  }
}`,
    'orm-query-in-loop',
  );
  const [count, exists] = findings;
  assert.equal(
    count.fix.changes[1].after,
    `  const roleEntityCounts = await ds.getRepository<Role>(RoleEntity)
    .createQueryBuilder('row')
    .select('row.clinicId', 'groupKey')
    .addSelect('COUNT(*)', 'total')
    .where({ clinicId: In(clinics.map((clinic) => clinic.id).filter((key) => key != null)) })
    .groupBy('row.clinicId')
    .getRawMany();
  const roleEntityCountByClinicId = new Map(roleEntityCounts.map((row) => [row.groupKey, Number(row.total)] as const));
  for (const clinic of clinics) {
    if (clinic.staff === 0 || (roleEntityCountByClinicId.get(clinic.id) ?? 0) > 0) continue;`,
  );
  assert.match(exists.fix.changes.at(-1).after, /new Set\(/);
  assert.match(exists.fix.changes.at(-1).after, /\.has\(name\);$/);
});

test('entries() loops map the owner and leave unused names out; In gets its own import when needed', (context) => {
  const entries = fixesFor(
    context,
    typeormFiles,
    `${typeormHeader}declare const repo: Repository<Role>;
const PLANS = [{ name: 'a' }];
declare const byCode: ReadonlyMap<string, { name: string }>;
export async function seed() {
  for (const [index, plan] of PLANS.entries()) {
    const role = await repo.findOne({ where: { name: plan.name } });
    console.log(index, role);
  }
  for (const [code, plan] of byCode.entries()) {
    const role = await repo.findOne({ where: { name: plan.name } });
    console.log(code, role);
  }
}`,
    'orm-query-in-loop',
  );
  assert.match(entries[0].fix.changes[1].after, /In\(PLANS\.map\(\(plan\) => plan\.name\)\)/);
  assert.match(
    entries[1].fix.changes[1].after,
    /In\(Array\.from\(byCode\.entries\(\), \(\[, plan\]\) => plan\.name\)\)/,
  );
  const imported = fixesFor(
    context,
    typeormFiles,
    `import type { Repository } from 'typeorm';
import { readFileSync } from 'node:fs';
declare const repo: Repository<{ id: number }>;
export async function load(ids: number[]) {
  readFileSync('x');
  for (const id of ids) {
    console.log(await repo.findOneBy({ id }));
  }
}`,
    'orm-query-in-loop',
  );
  assert.equal(
    imported[0].fix.changes[0].after,
    "import { readFileSync } from 'node:fs';\nimport { In } from 'typeorm';",
  );
});

test('Prisma aggregate and count per item become one groupBy with the empty result as default', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function totals(items: Item[]) {
  for (const item of items) {
    const stats = await prisma.user.aggregate({ where: { id: item.userId }, _avg: { score: true }, _count: { _all: true } });
    console.log(stats._count._all, stats._avg.score);
  }
  for (const item of items) {
    if ((await prisma.user.count({ where: { id: item.userId, active: true } })) === 0) console.log(item);
  }
}`,
    'prisma-query-in-loop',
  );
  assert.deepEqual(findings.map(afterTexts), [
    [
      `  const userTotals = await prisma.user.groupBy({ by: ['id'], where: { id: { in: items.map((item) => item.userId) } }, _avg: { score: true }, _count: { _all: true } });
  const userTotalById = new Map(userTotals.map((row) => [row.id, row] as const));
  for (const item of items) {
    const stats = userTotalById.get(item.userId) ?? { _avg: { score: null }, _count: { _all: 0 } };`,
    ],
    [
      `  const userCounts = await prisma.user.groupBy({ by: ['id'], where: { id: { in: items.map((item) => item.userId) }, active: true }, _count: { _all: true } });
  const userCountById = new Map(userCounts.map((row) => [row.id, row._count._all] as const));
  for (const item of items) {
    if ((userCountById.get(item.userId) ?? 0) === 0) console.log(item);`,
    ],
  ]);
});

test('a key held in a const of the loop body is computed per item up front', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}const STATUSES = ['new', 'paid'];
export async function seed(storeIndex: number) {
  for (const [statusIndex, status] of STATUSES.entries()) {
    const key = \`order-\${storeIndex}-\${statusIndex}\`;
    const existing = await prisma.user.findUnique({ where: { key } });
    if (existing) continue;
    await prisma.user.create({ data: { key, status } });
  }
}`,
    'prisma-query-in-loop',
  );
  assert.equal(
    findings[0].fix.changes[0].after,
    `  const users = await prisma.user.findMany({ where: { key: { in: STATUSES.map((_status, statusIndex) => \`order-\${storeIndex}-\${statusIndex}\`) } } });
  const usersByKey = new Map(users.map((user) => [user.key, user] as const));
  for (const [statusIndex, status] of STATUSES.entries()) {
    const key = \`order-\${storeIndex}-\${statusIndex}\`;
    const existing = usersByKey.get(key) ?? null;`,
  );
  // The create depends on the lookup, so it stays per item.
  assert.equal(findings[1].fix, undefined);
});

test('per-item Prisma writes become one $transaction, split around a long body; a tx client is left alone', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}declare const tx: PrismaClient;
export async function rename(items: Item[]) {
  await Promise.all(items.map((item) => prisma.user.update({ where: { id: item.userId }, data: { name: item.name } })));
  await Promise.all(items.map((item) => tx.user.update({ where: { id: item.userId }, data: { name: item.name } })));
  for (const [index, item] of items.entries()) {
    await prisma.user.create({
      data: {
        name: item.name,
        position: index,
        team: { connect: { id: 1 } },
        profile: { create: { bio: item.name } },
        active: true,
      },
    });
  }
}`,
    'prisma-query-in-loop',
  );
  assert.deepEqual(findings.map(afterTexts), [
    [
      '  await prisma.$transaction(items.map((item) => prisma.user.update({ where: { id: item.userId }, data: { name: item.name } })));',
    ],
    undefined,
    ['  await prisma.$transaction(items.map((item, index) => prisma.user.create({', '    })));'],
  ]);
});

test('createMany over a Map keeps every name the row reads, spreads included', (context) => {
  const findings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function stats(byDay: Map<string, { total: number }>, storeId: number) {
  for (const [day, totals] of byDay) {
    await prisma.user.create({ data: { storeId, day, ...totals } });
  }
}`,
    'prisma-query-in-loop',
  );
  assert.equal(
    only(findings).after,
    'await prisma.user.createMany({ data: Array.from(byDay, ([day, totals]) => ({ storeId, day, ...totals })) });',
  );
});

test('Redis DELs and SETs become one DEL and one pipeline; a guarded get skips missing keys', (context) => {
  const findings = fixesFor(
    context,
    redisFiles,
    `import type { Redis } from 'ioredis';
declare const redis: Redis;
export async function run(names: string[], sessions: { token: string }[]) {
  await Promise.all(names.splice(0).map((key) => redis.del(key)));
  await Promise.all(names.map((key) => redis.set(key, 'stale', 'EX', 60)));
  for (const { token } of sessions) {
    if (!token) continue;
    const raw = await redis.get(token);
    console.log(raw);
  }
  for (const { token } of sessions) {
    const raw = await redis.get(token);
    if (raw) await redis.eval('return 1', 1, token);
  }
}`,
    'redis-command-in-loop',
  );
  assert.deepEqual(findings.map(afterTexts), [
    ['  const keysToDelete = names.splice(0);\n  if (keysToDelete.length) await redis.del(...keysToDelete);'],
    [
      "  await redis.pipeline(names.map((key) => ['set', key, 'stale', 'EX', 60])).exec().then((replies) => (replies ?? []).map(([error, reply]) => { if (error) throw error; return reply; }));",
    ],
    [
      `  const keys = sessions.map(({ token }) => token).filter((key) => key != null);
  const values = keys.length ? await redis.mget(keys) : [];
  const rawByKey = new Map(keys.map((key, index) => [key, values[index]] as const));
  for (const { token } of sessions) {
    if (!token) continue;
    const raw = rawByKey.get(token) ?? null;`,
    ],
    // A later command may act on the key just read, and a queried list can repeat a token.
    undefined,
  ]);
});

test('a TypeORM list read per item becomes one In read grouped by key, keeping the shared order', (context) => {
  const findings = fixesFor(
    context,
    typeormFiles,
    `import { Repository } from 'typeorm';
type Post = { id: number, authorId: number, title: string };
declare const postRepository: Repository<Post>;
export async function titles(authors: { id: number }[], items: { authorId: number }[]) {
  for (const author of authors) {
    const posts = await postRepository.find({ where: { authorId: author.id }, order: { id: 'DESC' } });
    console.log(posts.map((post) => post.title));
  }
  for (const item of items) {
    console.log(await postRepository.findBy({ authorId: item.authorId }));
  }
}`,
    'orm-query-in-loop',
  );
  assert.equal(findings.length, 2);
  const [byOwnId, byForeignKey] = findings.map((finding) => finding.fix.changes.at(-1).after);
  assert.equal(
    byOwnId,
    `  const existingPosts = await postRepository.find({ where: { authorId: In(authors.map((author) => author.id)) }, order: { id: 'DESC' } });
  const existingPostsByAuthorId = new Map<unknown, typeof existingPosts>();
  for (const post of existingPosts) {
    const group = existingPostsByAuthorId.get(post.authorId) ?? [];
    group.push(post);
    existingPostsByAuthorId.set(post.authorId, group);
  }
  for (const author of authors) {
    const posts = existingPostsByAuthorId.get(author.id) ?? [];`,
  );
  // Items may share a foreign key, so each gets its own copy of the list, as its own query returned.
  assert.match(
    byForeignKey,
    /console\.log\(\[\.\.\.\(existingPostsByAuthorId\.get\(item\.authorId\) \?\? \[\]\)\]\);$/,
  );
  assert.match(findings[1].fix.note, /grouped through a Map in query order.*null or undefined now gets no rows/s);
  assert.doesNotMatch(findings[0].fix.note, /null or undefined/);
});

test('a Prisma findMany per item in a CommonJS file with CRLF and tabs keeps the file style', (context) => {
  const crlf = (text) => text.replace(/\n/g, '\r\n');
  const { findings } = scanWithFixes(context, {
    ...prismaFiles,
    'src/report.cjs': crlf(`'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function report(users) {
\tfor (const user of users) {
\t\tconst rows = await prisma.user.findMany({ where: { id: user.id }, select: { score: true }, orderBy: { score: 'desc' } });
\t\tconsole.log(rows.length);
\t}
}
module.exports = { report };
`),
  });
  const finding = findings.find((candidate) => candidate.ruleId === 'prisma-query-in-loop');
  assert.equal(
    onlyChange(finding).after,
    [
      "const existingUsers = await prisma.user.findMany({ where: { id: { in: Array.from(users, (user) => user.id) } }, select: { score: true, id: true }, orderBy: { score: 'desc' } });",
      'const existingUsersById = new Map();',
      'for (const user of existingUsers) {',
      '\tconst group = existingUsersById.get(user.id) ?? [];',
      '\tgroup.push(user);',
      '\texistingUsersById.set(user.id, group);',
      '}',
      'for (const user of users) {',
      '\tconst rows = existingUsersById.get(user.id) ?? [];',
    ].join('\n'),
  );
  assert.match(finding.fix.note, /also reads `id`/);
});

test('list reads that page, pick distinct rows, filter on a relation or run in a try are not batched', (context) => {
  const prismaFindings = fixesFor(
    context,
    prismaFiles,
    `${prismaHeader}export async function load(items: Item[]) {
  for (const item of items) console.log(await prisma.user.findMany({ where: { id: item.userId }, take: 5 }));
  for (const item of items) console.log(await prisma.user.findMany({ where: { id: item.userId }, distinct: ['score'] }));
  for (const item of items) console.log(await prisma.user.findMany({ where: { profile: { id: item.userId } } }));
  for (const item of items) {
    try {
      console.log(await prisma.user.findMany({ where: { id: item.userId } }));
    } catch {}
  }
}`,
    'prisma-query-in-loop',
  );
  assert.equal(prismaFindings.length, 4);
  for (const finding of prismaFindings) assert.equal(finding.fix, undefined);
  const typeormFindings = readFindings(
    fixesFor(
      context,
      typeormFiles,
      `${typeormHeader}declare const repo: Repository<Role>;
export async function load(entries: { id: number }[]) {
  for (const entry of entries) console.log(await repo.find({ where: { clinicId: entry.id }, skip: 10 }));
  for (const entry of entries) {
    await repo.save({ id: entry.id, name: 'x', clinicId: entry.id });
    console.log(await repo.find({ where: { clinicId: entry.id } }));
  }
}`,
      'orm-query-in-loop',
    ),
  );
  assert.equal(typeormFindings.length, 2);
  for (const finding of typeormFindings) assert.equal(finding.fix, undefined);
});
