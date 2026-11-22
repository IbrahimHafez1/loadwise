'use strict';

// Minimal declaration packages for the fix-verification samples; nothing here needs to be installed.
const nodeModules = {
  'node-types.d.ts': [
    "declare module 'node:fs' { export function readFileSync(file: string): string; }",
    "declare module 'node:crypto' {",
    '  export function randomInt(max: number): number;',
    '  export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;',
    '}',
    "declare module 'node:buffer' {",
    '  export class Buffer extends Uint8Array { static from(text: string, encoding?: string): Buffer; }',
    '}',
  ].join('\n'),
};

// Node modules typed as `any`: the samples only need their imports to resolve.
const anyNodeModules = {
  'any-node-modules.d.ts': [
    ...['fs', 'fs/promises', 'zlib', 'crypto', 'util', 'child_process', 'stream', 'stream/promises', 'events'].flatMap(
      (name) => [`declare module '${name}';`, `declare module 'node:${name}';`],
    ),
    'type Buffer = Uint8Array;',
  ].join('\n'),
};

const bcrypt = {
  'node_modules/bcrypt/index.d.ts':
    'declare const bcrypt: { hash(password: string, cost: number): Promise<string> }; export default bcrypt;',
};

const jsonwebtoken = {
  'node_modules/jsonwebtoken/index.d.ts': [
    'declare const jwt: {',
    '  sign(payload: object, secret: string, options?: object): string;',
    '  verify(token: string, secret: string, options?: object): unknown;',
    '};',
    'export default jwt;',
  ].join('\n'),
};

const cors = {
  'node_modules/cors/index.d.ts': 'declare function cors(options?: object): unknown; export default cors;',
};

const pg = {
  'node_modules/@types/pg/index.d.ts': `type Input = string | {text: string, values?: unknown[]};
export class Pool {
  query(statement: Input, values?: unknown[]): Promise<unknown>;
  connect(): Promise<PoolClient>;
}
export class Client {query(statement: Input, values?: unknown[]): Promise<unknown>}
export interface PoolClient extends Client {release(): void}`,
};

const mongoose = {
  'node_modules/mongoose/index.d.ts': [
    'export interface Model<T> { find(filter?: object): unknown; findOne(filter?: object): unknown; }',
    'export declare function model<T>(name: string, schema?: unknown): Model<T>;',
    'declare const mongoose: { model: typeof model }; export default mongoose;',
  ].join('\n'),
  'models/user.ts': "import mongoose from 'mongoose';\nexport const User = mongoose.model('User', {});",
};

const prisma = {
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

const drizzle = {
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

const prismaPolicy = {
  prismaScopes: { Invoice: { field: 'tenantId', from: '@app/auth', export: 'requireTenantId' } },
};
const drizzlePolicy = {
  drizzleScopes: { invoices: { tableFrom: '@app/schema', field: 'tenantId', from: '@app/auth', export: 'tenant' } },
};

const queue = {
  'node_modules/bullmq/index.d.ts':
    'export declare class Queue { add(name: string, data: any, opts?: any): Promise<{ id: string }>; addBulk(jobs: any[]): Promise<any[]>; }',
};

const ioredis = {
  'node_modules/ioredis/index.d.ts':
    'export class Redis { keys(pattern: string): Promise<string[]>; scanStream(options: object): AsyncIterable<string[]>; }',
};

const prismaStore = {
  'node_modules/@prisma/client/index.d.ts': `export interface StoreDelegate {
  count(args?: object): Promise<number>;
  findFirst(args?: object): Promise<{ id: number } | null>;
}
export declare class PrismaClient { store: StoreDelegate }`,
  'prisma/schema.prisma': 'model Store {\n  id Int @id\n  slug String\n}\n',
};

module.exports = {
  queue,
  ioredis,
  prismaStore,
  nodeModules,
  anyNodeModules,
  bcrypt,
  jsonwebtoken,
  cors,
  pg,
  mongoose,
  prisma,
  drizzle,
  prismaPolicy,
  drizzlePolicy,
};
