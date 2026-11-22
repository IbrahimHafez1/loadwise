'use strict';

// One minimal sample per performance fix builder, taken from the rule's own tests.
const packages = require('./package-stubs.cjs');

function sample(ruleId, source, extraFiles = {}, policy) {
  return { ruleId, files: { 'package.json': '{}', 'src/app.ts': source, ...extraFiles }, policy };
}

const nodeSamples = [
  sample(
    'node-sync-fs-in-async',
    "import fs from 'node:fs';\nexport async function save(path: string, body: string) {\n  fs.writeFileSync(path, body, 'utf8');\n}\n",
    packages.anyNodeModules,
  ),
  sample(
    'node-sync-compression-in-async',
    "import zlib from 'zlib';\nexport async function pack(buffer: Buffer) {\n  const packed = zlib.gzipSync(buffer, { level: 9 });\n  return packed;\n}\n",
    packages.anyNodeModules,
  ),
  sample(
    'node-sync-crypto-in-async',
    "import crypto from 'crypto';\nexport async function derive(password: string, salt: Buffer) {\n  const key = crypto.scryptSync(password, salt, 64);\n  return key;\n}\n",
    packages.anyNodeModules,
  ),
  sample(
    'node-sync-process-in-async',
    "import { execSync } from 'child_process';\nexport async function build(directory: string) {\n  execSync('npm run build', { cwd: directory });\n}\n",
    packages.anyNodeModules,
  ),
  sample(
    'password-hash-sync-in-async',
    "import * as bcrypt from 'bcrypt';\nexport async function login(password: string, stored: string) {\n  const ok = bcrypt.compareSync(password, stored);\n  return ok;\n}\n",
    {
      'node_modules/bcrypt/index.d.ts':
        'export function compareSync(data: string, hash: string): boolean;\nexport function compare(data: string, hash: string): Promise<boolean>;',
    },
  ),
];

const collectionSamples = [
  sample(
    'array-repeated-membership',
    'export function pick(rows: { id: number }[], allowedIds: number[]) {\n  return rows.filter((row) => allowedIds.includes(row.id));\n}\n',
  ),
  sample(
    'array-repeated-find',
    'interface Item { id: string }\nexport function link(orders: { itemId: string }[], items: Item[]) {\n  return orders.map((order) => items.find((item) => item.id === order.itemId));\n}\n',
  ),
  sample(
    'filter-for-existence',
    'export function check(items: { active: boolean }[]) {\n  return items.filter((item) => item.active).length > 0;\n}\n',
  ),
  sample(
    'numeric-sort-for-extreme',
    'export function best(scores: number[]) {\n  return [...scores].sort((a, b) => a - b)[0];\n}\n',
  ),
  sample(
    'reduce-copy-accumulator',
    'export function names(rows: { name: string }[]) {\n  return rows.reduce((acc: string[], row) => [...acc, row.name], []);\n}\n',
  ),
  sample(
    'loop-copy-accumulator',
    'export function names(rows: { name: string }[]) {\n  let result: string[] = [];\n  for (const row of rows) {\n    result = [...result, row.name];\n  }\n  return result;\n}\n',
  ),
  sample(
    'rebuild-lookup-in-loop',
    'export function count(rows: number[], ids: number[]) {\n  let total = 0;\n  for (const row of rows) {\n    if (new Set(ids).has(row)) total++;\n  }\n  return total;\n}\n',
  ),
  sample(
    'promise-combinator-serial-await',
    'declare function loadUser(id: string): Promise<string>;\ndeclare function loadPosts(id: string): Promise<string>;\nexport async function load(id: string) {\n  return Promise.all([await loadUser(id), (await loadPosts(id))]);\n}\n',
  ),
];

const smallRewriteSamples = [
  sample(
    'json-roundtrip-clone',
    'export function run(items: object[]) {\n  const copies: object[] = [];\n  for (const item of items) copies.push(JSON.parse(JSON.stringify(item)));\n  return copies;\n}\n',
  ),
  sample('return-newline', "function labeledBlock() {\n  return\n  { error: 'Unavailable' }\n}\n"),
  sample(
    'queue-add-in-loop',
    "import { Queue } from 'bullmq';\nexport async function run(queue: Queue, ids: string[]) {\n  for (const id of ids) {\n    await queue.add('job', { id });\n  }\n}\n",
    packages.queue,
  ),
  sample(
    'redis-keys-command',
    "import { Redis } from 'ioredis';\ndeclare const redis: Redis;\nexport const sessionKeys = await redis.keys('session:*');\n",
    packages.ioredis,
  ),
  sample(
    'serial-awaits-in-literal',
    'declare function a(): Promise<number>;\ndeclare function b(): Promise<number>;\ndeclare function wrap(value: object): object;\nexport const build = async () => wrap({ x: await a(), y: await b() });\n',
  ),
  sample(
    'prisma-count-for-existence',
    "import { PrismaClient } from '@prisma/client';\ndeclare const prisma: PrismaClient;\ndeclare const where: { slug: string };\nexport async function taken() {\n  return (await prisma.store.count({ where })) > 0;\n}\n",
    packages.prismaStore,
  ),
];

const bcryptTypes = 'export function hash(data: string, rounds: number | string): Promise<string>;';
const retryStubs = {
  'node_modules/axios-retry/index.d.ts':
    'declare function axiosRetry(client: object): void; export default axiosRetry;',
};
const redisChainTypes = `export interface ChainableCommander {
  incr(key: string): ChainableCommander;
  expire(key: string, seconds: number): ChainableCommander;
  exec(): Promise<[Error | null, unknown][] | null>;
}
export class Redis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  multi(): ChainableCommander;
}`;
const typeormPageStub = `export class Repository<T> {
  find(options?: object): Promise<T[]>;
  count(options?: object): Promise<number>;
  findAndCount(options?: object): Promise<[T[], number]>;
}`;
const typeormCartesianStub = `export declare class Repository<T> { find(options?: object): Promise<T[]>; }`;
const multerStubs = {
  'node_modules/@nestjs/platform-express/index.d.ts':
    'export declare function FileInterceptor(field: string, options?: any): any;',
};

const shapeSamples = [
  sample(
    'async-route-unhandled-rejection',
    "declare const app: { get(path: string, handler: (req: any, res: any, next: (error?: unknown) => void) => unknown): void };\ndeclare function load(): Promise<string>;\napp.get('/users', async (req, res) => {\n  const users = await load();\n  res.json(users);\n});\n",
    { 'package.json': JSON.stringify({ name: 'fixture', dependencies: { express: '^4.18.2' } }) },
  ),
  sample(
    'stream-pipe-unhandled-error',
    "import fs from 'node:fs';\nimport zlib from 'node:zlib';\nexport async function send(req: any, res: any) {\n  fs.createReadStream('a').pipe(zlib.createGzip()).pipe(res);\n}\n",
    packages.anyNodeModules,
  ),
  sample('http-call-without-timeout', "export async function one() { await fetch('https://a.test'); }\n"),
  sample(
    'upload-without-size-limit',
    "import { FileInterceptor } from '@nestjs/platform-express';\nexport const a = FileInterceptor('file');\n",
    multerStubs,
  ),
  sample(
    'password-hash-pure-js',
    "import * as bcrypt from 'bcryptjs';\nexport const a = () => bcrypt.hash('p', 10);\n",
    {
      'package.json': JSON.stringify({ dependencies: { bcrypt: '^6.0.0', bcryptjs: '^2.4.3' } }),
      'node_modules/bcryptjs/index.d.ts': bcryptTypes,
      'node_modules/bcrypt/index.d.ts': bcryptTypes,
    },
  ),
  sample(
    'count-then-page-serial',
    "import { Repository } from 'typeorm';\ndeclare const repo: Repository<object>;\ndeclare const where: object;\ndeclare const page: number;\ndeclare const limit: number;\nexport async function list() {\n  const total = await repo.count({ where });\n  const rows = await repo.find({ where, skip: page, take: limit });\n  return { rows, total };\n}\n",
    { 'node_modules/typeorm/index.d.ts': typeormPageStub },
  ),
  sample(
    'orm-cartesian-include',
    "import { Repository } from 'typeorm';\nclass Tag { id!: number; }\nclass Post { id!: number; }\nclass User { id!: number; posts!: Post[]; tags!: Tag[]; }\ndeclare const users: Repository<User>;\nexport const run = () => users.find({ relations: ['posts', 'tags'] });\n",
    { 'node_modules/typeorm/index.d.ts': typeormCartesianStub },
  ),
  sample(
    'redis-incr-then-expire',
    "import { Redis } from 'ioredis';\nexport async function hit(redis: Redis, key: string) {\n  await redis.incr(key);\n  await redis.expire(key, 60);\n}\n",
    { 'node_modules/ioredis/index.d.ts': redisChainTypes },
  ),
  sample(
    'retry-without-backoff',
    'export async function load(url: string) {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    try {\n      return await fetch(url);\n    } catch (error) {\n      console.warn(error);\n    }\n  }\n}\n',
    retryStubs,
  ),
];

const performanceCases = [...nodeSamples, ...collectionSamples, ...smallRewriteSamples, ...shapeSamples];

module.exports = { performanceCases };
