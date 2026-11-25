// Performance fix samples for pooling, transactions and write ordering, taken from the integrity
// and write rule tests.
import type { FixVerificationCase } from '../../../types/fix-verification.js';
import type { FileMap } from '../../../types/project-files.js';
import type { PerformancePolicy } from '../../../../lib/performance/types/performance-policy.js';

function sample(
  ruleId: string,
  source: string,
  extraFiles: FileMap = {},
  policy?: PerformancePolicy,
): FixVerificationCase {
  return { ruleId, files: { 'package.json': '{}', 'src.ts': source, ...extraFiles }, policy };
}

const pgFiles = {
  'node_modules/@types/pg/index.d.ts': `type Input = string | {text: string, values?: unknown[]};
export class Pool {
  constructor(config?: object);
  query(statement: Input, values?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}
export class Client {query(statement: Input, values?: unknown[]): Promise<{ rows: unknown[] }>}
export interface PoolClient extends Client {release(): void}`,
  'node_modules/@types/express/index.d.ts':
    'export interface Router { get(path: string, handle: (request: { query: object }) => unknown): void }',
};

const prismaTransactionFiles = {
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

const prismaWriteFiles = {
  'node_modules/@prisma/client/index.d.ts': `
    export interface Stock { quantity: number; label: string }
    export interface OrderDelegate { create(input: object): Promise<{ id: number; handle: string }> }
    export interface ItemDelegate { create(input: object): Promise<{ id: number }> }
    export interface StockDelegate {
      findUniqueOrThrow(args: object): Promise<Stock>;
      update(args: object): Promise<Stock>;
    }
    export interface TransactionClient { order: OrderDelegate; item: ItemDelegate; stock: StockDelegate }
    export class PrismaClient {
      order: OrderDelegate; item: ItemDelegate; stock: StockDelegate;
      $transaction<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T>
    }
  `,
};

const performanceIntegrityCases: FixVerificationCase[] = [
  sample(
    'pg-transaction-on-pool',
    [
      "import { Pool } from 'pg';",
      'export async function transfer(pool: Pool, from: number, to: number) {',
      "  await pool.query('BEGIN');",
      "  await pool.query('UPDATE accounts SET balance = balance - 1 WHERE id = $1', [from]);",
      "  await pool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [to]);",
      "  await pool.query('COMMIT');",
      '}',
      '',
    ].join('\n'),
    pgFiles,
  ),
  sample(
    'pg-unreleased-checkout',
    [
      "import { Pool } from 'pg';",
      'declare const pool: Pool;',
      'export async function run() {',
      "  return (await pool.connect()).query('SELECT 1');",
      '}',
      '',
    ].join('\n'),
    pgFiles,
  ),
  sample(
    'pool-created-per-request-or-item',
    [
      "import { Pool } from 'pg';",
      "import type { Router } from 'express';",
      'declare const router: Router;',
      'const connectionString = process.env.DATABASE_URL;',
      '',
      "router.get('/users', async () => {",
      '  const pool = new Pool({ connectionString, max: 5 });',
      "  const { rows } = await pool.query('SELECT id FROM users');",
      '  await pool.end();',
      '  return rows;',
      '});',
      '',
    ].join('\n'),
    pgFiles,
  ),
  sample(
    'prisma-transaction-client-escape',
    [
      "import { PrismaClient } from '@prisma/client';",
      'export async function run(db: PrismaClient) {',
      '  return db.$transaction(async (tx) => {',
      '    await db.stock.create({});',
      '    await tx.stock.update({});',
      '  });',
      '}',
      '',
    ].join('\n'),
    prismaTransactionFiles,
  ),
  sample(
    'prisma-read-modify-write',
    [
      "import { PrismaClient } from '@prisma/client';",
      'export async function run(db: PrismaClient, id: string, amount: number) {',
      '  const item = await db.stock.findUniqueOrThrow({ where: { id } });',
      '  await db.stock.update({ where: { id }, data: { quantity: item.quantity - amount } });',
      '}',
      '',
    ].join('\n'),
    prismaWriteFiles,
  ),
  sample(
    'prisma-dependent-writes',
    [
      "import { PrismaClient } from '@prisma/client';",
      'export async function run(db: PrismaClient) {',
      '  const order = await db.order.create({ data: {} });',
      '  await db.item.create({ data: { orderId: order.id } });',
      '}',
      '',
    ].join('\n'),
    prismaWriteFiles,
  ),
];

export { performanceIntegrityCases };
