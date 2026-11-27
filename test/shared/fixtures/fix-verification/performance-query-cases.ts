// Performance fix samples for ORM and database call shapes, taken from the query-loop and TypeORM
// rule tests.
import type { FixVerificationCase } from '../../../types/fix-verification.js';
import type { FileMap } from '../../../types/project-files.js';
import type { PerformancePolicy } from '../../../../lib/performance/types/performance-policy.js';

function sample(
  ruleId: string,
  source: string,
  extraFiles: FileMap = {},
  policy?: PerformancePolicy,
): FixVerificationCase {
  return { ruleId, files: { 'package.json': '{}', 'src/service.ts': source, ...extraFiles }, policy };
}

const prismaFiles = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate {
  findMany(options?: object): Promise<{ id: number, active: boolean, score: number }[]>;
  findUnique(options: object): Promise<{ id: number } | null>;
  count(options?: object): Promise<number>;
  create(options: object): Promise<{ id: number }>;
  createMany(options: object): Promise<{ count: number }>;
  findFirst(options: object): Promise<{ id: number } | null>;
}
export declare class PrismaClient { user: UserDelegate; }`,
};
const prismaHeader = `import type { PrismaClient } from '@prisma/client';
type Item = { userId: number, name: string };
declare const prisma: PrismaClient;
`;
const typeormFiles = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  findBy(filter: object): Promise<T[]>;
  findOneBy(filter: object): Promise<T | null>;
  find(options?: object): Promise<T[]>;
  findOne(options: object): Promise<T | null>;
  count(options?: object): Promise<number>;
  existsBy(filter: object): Promise<boolean>;
}
export function In(ids: unknown[]): object;`,
  'node_modules/sequelize/index.d.ts': 'export class Model { static findAll(options?: object): Promise<Model[]>; }',
};
const pgFiles = {
  'node_modules/@types/pg/index.d.ts':
    'interface PgResult { rows: any[] }\nexport class Pool { query(input: string, values?: unknown[]): Promise<PgResult>; }',
};
const redisFiles = {
  'node_modules/ioredis/index.d.ts': `export class Redis {
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<(string | null)[]>;
}`,
};

const queryLoopSamples = [
  sample(
    'prisma-query-in-loop',
    `${prismaHeader}export async function save(items: Item[]) {
  for (const item of items) {
    await prisma.user.create({ data: { name: item.name, active: true } });
  }
}
`,
    prismaFiles,
  ),
  sample(
    'orm-query-in-loop',
    `import { Repository } from 'typeorm';
type Order = { userId: number };
declare const userRepository: Repository<{ id: number }>;
export async function load(orders: Order[]) {
  for (const order of orders) {
    const user = await userRepository.findOneBy({ id: order.userId });
    console.log(user);
  }
}
`,
    typeormFiles,
  ),
  sample(
    'pg-query-in-loop',
    `import type { Pool } from 'pg';
type Item = { userId: number };
export async function load(pool: Pool, items: Item[]) {
  for (const item of items) {
    const { rows } = await pool.query('SELECT id, label FROM users WHERE id = $1', [item.userId]);
    console.log(rows);
  }
}
`,
    pgFiles,
  ),
  sample(
    'redis-command-in-loop',
    `import type { Redis } from 'ioredis';
declare const redis: Redis;
export async function load(ids: string[]) {
  for (const id of ids) {
    const cached = await redis.get(\`user:\${id}\`);
    console.log(cached);
  }
}
`,
    redisFiles,
  ),
];

const materializationSamples = [
  sample(
    'prisma-count-materialization',
    `${prismaHeader}export async function read() {
  const where = { active: true };
  const total = (await prisma.user.findMany({ where })).length;
  return total;
}
`,
    prismaFiles,
  ),
  sample(
    'prisma-first-materialization',
    `${prismaHeader}export async function read() {
  const where = { active: true };
  const first = (await prisma.user.findMany({ where, orderBy: { id: 'asc' } }))[0];
  return first?.id;
}
`,
    prismaFiles,
  ),
  sample(
    'prisma-filter-materialization',
    `${prismaHeader}export async function read() {
  const inactive = (await prisma.user.findMany({ select: { active: true } })).filter((row) => row.active === false);
  return inactive;
}
`,
    prismaFiles,
  ),
  sample(
    'prisma-top-k-materialization',
    `${prismaHeader}export async function read() {
  const top = (await prisma.user.findMany()).sort((a, b) => b.score - a.score).slice(0, 3);
  return top;
}
`,
    prismaFiles,
  ),
  sample(
    'pg-first-materialization',
    `import type { Pool } from 'pg';
export async function read(pool: Pool) {
  const first = (await pool.query('SELECT * FROM items WHERE id > $1 ORDER BY id;', [5])).rows[0];
  return first;
}
`,
    pgFiles,
  ),
  sample(
    'pg-count-materialization',
    `import type { Pool } from 'pg';
export async function read(pool: Pool) {
  const total = (await pool.query('select id from items where active = $1', [true])).rows.length;
  return total;
}
`,
    pgFiles,
  ),
  sample(
    'typeorm-existence-materialization',
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
export async function check() {
  const found = await repo.findOneBy({ id: 5 });
  if (!found) return;
}
`,
    typeormFiles,
  ),
  sample(
    'orm-count-materialization',
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
export async function counts() {
  const total = (await repo.find({ where: { active: true } })).length;
  return total;
}
`,
    typeormFiles,
  ),
];

const performanceQueryCases: FixVerificationCase[] = [...queryLoopSamples, ...materializationSamples];

export { performanceQueryCases };
