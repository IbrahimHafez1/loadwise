import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const files = {
  'node_modules/@prisma/client/index.d.ts': `
  export interface Stock { quantity: number; version: number; }
  export interface StockDelegate {
    findUnique(args: object): Promise<Stock | null>;
    findUniqueOrThrow(args: object): Promise<Stock>;
    update(args: object): Promise<Stock>;
    create(args: object): Promise<Stock>;
  }
  export interface TransactionClient { stock: StockDelegate }
  export declare class PrismaClient {
    stock: StockDelegate;
    $transaction<T>(fn: (tx: TransactionClient) => Promise<T>, options?: object): Promise<T>;
  }`,
};
const header = "import { PrismaClient } from '@prisma/client';";
const results = (source: string) =>
  lint(header + '\n' + source, files)
    .filter((finding: Finding) =>
      ['prisma-transaction-client-escape', 'prisma-read-modify-write'].includes(finding.ruleId),
    )
    .map((finding: Finding) => [finding.line, finding.ruleId]);

test('finds the same outer Prisma client inside an interactive transaction', () => {
  assert.deepEqual(
    results(`async function run(db: PrismaClient, other: PrismaClient) {
    return db.$transaction(async tx => {
      await db.stock.create({});
      await tx.stock.create({});
      await other.stock.create({});
      const deferred = () => db.stock.create({});
      { const db = other; await db.stock.create({}); }
    });
  }
  class Warehouse {
    constructor(readonly db: PrismaClient) {}
    save() { return this.db.$transaction(async tx => { await this.db.stock.update({}); }); }
  }`),
    [
      [4, 'prisma-transaction-client-escape'],
      [13, 'prisma-transaction-client-escape'],
    ],
  );
});

test('ignores user-defined transaction managers even with a genuine Prisma delegate', () => {
  assert.deepEqual(
    results(`async function run(typed: PrismaClient) {
    const db = { stock: typed.stock, $transaction: async (fn: () => Promise<void>) => fn() };
    return db.$transaction(async () => { await db.stock.create({}); });
  }`),
    [],
  );
});

test('transaction escape requires a consumed query or a direct return to the transaction', () => {
  assert.deepEqual(
    results(`async function run(db: PrismaClient) {
    await db.$transaction(async tx => {
      db.stock.create({});
      const unobserved = db.stock.create({});
      void db.stock.update({});
      await Promise.all([db.stock.create({}), tx.stock.create({})]);
      db.stock.create({}).catch(() => undefined);
    });
    await db.$transaction(tx => db.stock.create({}));
  }`),
    [
      [7, 'prisma-transaction-client-escape'],
      [8, 'prisma-transaction-client-escape'],
      [10, 'prisma-transaction-client-escape'],
    ],
  );
});

test('discarded and stored update builders do not establish a database write', () => {
  assert.deepEqual(
    results(`async function run(db: PrismaClient, id: string) {
    const first = await db.stock.findUniqueOrThrow({where:{id}});
    db.stock.update({where:{id},data:{quantity:first.quantity-1}});
    const second = await db.stock.findUniqueOrThrow({where:{id}});
    const queued = db.stock.update({where:{id},data:{quantity:second.quantity-1}});
  }`),
    [],
  );
});

test('links arithmetic writes to the exact numeric field, row key, delegate, and earlier binding', () => {
  assert.deepEqual(
    results(`async function reserve(db: PrismaClient, id: string, amount: number) {
    const item = await db.stock.findUnique({ where: { id } });
    if (!item) return;
    return db.stock.update({ where: { id: id }, data: { quantity: item.quantity - amount } });
  }
  async function add(db: PrismaClient, amount: number) {
    const item = await db.stock.findUniqueOrThrow({ where: { id: 42 } });
    await db.stock.update({ where: { id: 42 }, data: { quantity: amount + item.quantity } });
  }`),
    [
      [5, 'prisma-read-modify-write'],
      [9, 'prisma-read-modify-write'],
    ],
  );
});

test('skips atomic writes, version guards, other rows or clients, and serializable transactions', () => {
  const clean = [
    'db.stock.update({ where: { id }, data: { quantity: { decrement: amount } } })',
    'db.stock.update({ where: { id, version: item.version }, data: { quantity: item.quantity - amount } })',
    'db.stock.update({ where: { id: otherId }, data: { quantity: item.quantity - amount } })',
    'db.stock.update({ where: { id }, data: { quantity: item.version - amount } })',
    'other.stock.update({ where: { id }, data: { quantity: item.quantity - amount } })',
  ];
  const cases = clean.map(
    (
      update,
      index,
    ) => `async function case${index}(db: PrismaClient, other: PrismaClient, id: string, otherId: string, amount: number) {
    const item = await db.stock.findUniqueOrThrow({where: {id}});
    await ${update};
  }`,
  );
  cases.push(`async function reserve(db: PrismaClient, id: string) {
    return db.$transaction(async tx => {
      const item = await tx.stock.findUniqueOrThrow({where: {id}});
      await tx.stock.update({where:{id},data:{quantity:item.quantity-1}});
    }, {isolationLevel:'Serializable'});
  }`);
  assert.deepEqual(results(cases.join('\n')), []);
});

test('tracks a read and write through the transaction client under default isolation', () => {
  assert.deepEqual(
    results(`async function reserve(db: PrismaClient, id: string) {
    return db.$transaction(async tx => {
      const item = await tx.stock.findUniqueOrThrow({ where: { id } });
      await tx.stock.update({ where: { id }, data: { quantity: item.quantity - 1 } });
    });
  }`),
    [[5, 'prisma-read-modify-write']],
  );
});
