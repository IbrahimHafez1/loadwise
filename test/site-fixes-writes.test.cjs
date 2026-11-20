'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const prismaStub = {
  'node_modules/@prisma/client/index.d.ts': `
    export type OrderWhereUniqueInput = { id?: number; slug?: string };
    export type OrderCreateNestedOneWithoutItemsInput = { connect?: OrderWhereUniqueInput };
    export type ItemCreateInput = { orderId?: number; order?: OrderCreateNestedOneWithoutItemsInput; message?: string };
    export interface Stock { quantity: number; label: string }
    export interface OrderDelegate { create(input: object): Promise<{ id: number; handle: string }> }
    export interface ItemDelegate {
      create<T extends { data: ItemCreateInput }>(input: T): Promise<{ id: number }>
      createMany(input: object): Promise<{ count: number }>
    }
    export interface StockDelegate {
      findUnique(args: object): Promise<Stock | null>;
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

const pgStub = {
  'node_modules/@types/pg/index.d.ts': `type Input = string | {text: string, values?: unknown[]};
export class Pool {
  query(statement: Input, values?: unknown[]): Promise<unknown>;
  connect(): Promise<PoolClient>;
}
export class Client {query(statement: Input, values?: unknown[]): Promise<unknown>}
export interface PoolClient extends Client {release(): void}`,
};

function fixFor(context, ruleId, source, stub) {
  const { findings } = scanWithFixes(context, { 'src.ts': source, ...stub });
  const matching = findings.filter((finding) => finding.ruleId === ruleId);
  return { matching, change: matching.length === 1 ? onlyChange(matching[0]) : undefined };
}

function dependent(context, body, header = 'async function run(db: PrismaClient) {', footer = '}') {
  const source = ["import { PrismaClient } from '@prisma/client';", header, body, footer].join('\n');
  return fixFor(context, 'prisma-dependent-writes', source, prismaStub);
}

test('dependent writes become one transaction on tx', (context) => {
  const { change } = dependent(
    context,
    [
      '  const order = await db.order.create({ data: {} });',
      '  await db.item.create({ data: { orderId: order.id } });',
    ].join('\n'),
  );
  assert.deepEqual(change, {
    before: [
      'const order = await db.order.create({ data: {} });',
      'await db.item.create({ data: { orderId: order.id } });',
    ].join('\n'),
    after: [
      'await db.$transaction(async (tx) => {',
      '  const order = await tx.order.create({ data: {} });',
      '  await tx.item.create({ data: { orderId: order.id } });',
      '});',
    ].join('\n'),
  });
});

test('dependent writes return the parent when later code uses it', (context) => {
  const source = [
    "import { PrismaClient } from '@prisma/client';",
    'export async function run(prisma: PrismaClient) {',
    '  if (prisma) {',
    '    const order = await prisma.order.create({ data: {} });',
    '    // The item belongs to the order.',
    '    await prisma.item.create({ data: { orderId: order.id } });',
    '    return order.id;',
    '  }',
    '}',
  ].join('\n');
  const { change } = fixFor(context, 'prisma-dependent-writes', source, prismaStub);
  assert.deepEqual(change, {
    before: [
      'const order = await prisma.order.create({ data: {} });',
      '// The item belongs to the order.',
      'await prisma.item.create({ data: { orderId: order.id } });',
    ].join('\n'),
    after: [
      'const order = await prisma.$transaction(async (tx) => {',
      '  const order = await tx.order.create({ data: {} });',
      '  // The item belongs to the order.',
      '  await tx.item.create({ data: { orderId: order.id } });',
      '  return order;',
      '});',
    ].join('\n'),
  });
});

test('dependent writes return both results when both are used later', (context) => {
  const { change } = dependent(
    context,
    [
      '  const order = await db.order.create({ data: {} });',
      '  const item = await db.item.create({ data: { orderId: order.id } });',
      '  return [order.id, item.id];',
    ].join('\n'),
  );
  assert.deepEqual(change.after.split('\n'), [
    'const { order, item } = await db.$transaction(async (tx) => {',
    '  const order = await tx.order.create({ data: {} });',
    '  const item = await tx.item.create({ data: { orderId: order.id } });',
    '  return { order, item };',
    '});',
  ]);
});

test('dependent writes ending in a return keep the return outside', (context) => {
  const { change } = dependent(
    context,
    [
      '  const order = await db.order.create({ data: {} });',
      '  return await db.item.createMany({ data: [{ orderId: order.id }] });',
    ].join('\n'),
  );
  assert.deepEqual(change.after.split('\n'), [
    'return await db.$transaction(async (tx) => {',
    '  const order = await tx.order.create({ data: {} });',
    '  return await tx.item.createMany({ data: [{ orderId: order.id }] });',
    '});',
  ]);
});

test('dependent writes without a safe rewrite get no fix', (context) => {
  const cases = {
    'extra await in the child': [
      '  const order = await db.order.create({ data: {} });',
      '  await db.item.create({ data: { orderId: order.id, message: await Promise.resolve("x") } });',
    ],
    'result needed after a returned write': [
      '  const order = await db.order.create({ data: {} });',
      '  return await db.item.createMany({ data: [{ orderId: order.id }] });',
      '  function later() { return order; }',
    ],
    'tx name already used in the statements': [
      '  const order = await db.order.create({ data: {} });',
      '  const tx = 1;',
      '  await db.item.create({ data: { orderId: order.id, message: String(tx) } });',
    ],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const { matching } = dependent(context, lines.join('\n'));
    assert.equal(matching.filter((finding) => finding.fix).length, 0, name);
  }
});

test('dependent writes through an alias or on top-level statements get no fix', (context) => {
  const aliased = fixFor(
    context,
    'prisma-dependent-writes',
    [
      "import { PrismaClient } from '@prisma/client';",
      'const db = new PrismaClient();',
      'const orders = db.order;',
      'async function run() {',
      '  const order = await orders.create({ data: {} });',
      '  await db.item.create({ data: { orderId: order.id } });',
      '}',
    ].join('\n'),
    prismaStub,
  );
  assert.equal(aliased.matching.length, 1);
  assert.equal(aliased.matching[0].fix, undefined);
  const topLevel = fixFor(
    context,
    'prisma-dependent-writes',
    [
      "import { PrismaClient } from '@prisma/client';",
      'const db = new PrismaClient();',
      'const order = await db.order.create({ data: {} });',
      'await db.item.create({ data: { orderId: order.id } });',
      'export {};',
    ].join('\n'),
    prismaStub,
  );
  assert.equal(topLevel.matching.filter((finding) => finding.fix).length, 0);
});

function readModifyWrite(context, updateLine) {
  return fixFor(
    context,
    'prisma-read-modify-write',
    [
      "import { PrismaClient } from '@prisma/client';",
      'async function run(db: PrismaClient, id: string, amount: number) {',
      '  const item = await db.stock.findUniqueOrThrow({ where: { id } });',
      `  ${updateLine}`,
      '}',
    ].join('\n'),
    prismaStub,
  );
}

test('read-modify-write becomes an atomic increment or decrement', (context) => {
  const increment = readModifyWrite(
    context,
    'await db.stock.update({ where: { id }, data: { quantity: item.quantity + 1 } });',
  );
  assert.deepEqual(increment.change, {
    before: '  await db.stock.update({ where: { id }, data: { quantity: item.quantity + 1 } });'.trim(),
    after: 'await db.stock.update({ where: { id }, data: { quantity: { increment: 1 } } });',
  });
  const decrement = readModifyWrite(
    context,
    'await db.stock.update({ where: { id }, data: { quantity: item.quantity - amount } });',
  );
  assert.equal(
    decrement.change.after,
    'await db.stock.update({ where: { id }, data: { quantity: { decrement: amount } } });',
  );
  const reversed = readModifyWrite(
    context,
    'await db.stock.update({ where: { id }, data: { quantity: amount + item.quantity } });',
  );
  assert.equal(
    reversed.change.after,
    'await db.stock.update({ where: { id }, data: { quantity: { increment: amount } } });',
  );
});

test('read-modify-write is left alone for any other arithmetic shape', (context) => {
  for (const expression of [
    'item.quantity * 2',
    'amount - item.quantity',
    'item.quantity + item.quantity',
    'item.quantity + amount * 2',
    'item.quantity - item.quantity',
  ]) {
    const { matching } = readModifyWrite(
      context,
      `await db.stock.update({ where: { id }, data: { quantity: ${expression} } });`,
    );
    assert.equal(matching.filter((finding) => finding.fix).length, 0, expression);
  }
});

function pgQuery(context, queryLine) {
  return fixFor(
    context,
    'pg-dynamic-query-text',
    [
      "import { Pool } from 'pg';",
      'async function run(pool: Pool, id: number, name: string, limit: number, table: string) {',
      `  ${queryLine}`,
      '}',
    ].join('\n'),
    pgStub,
  );
}

test('dynamic pg query text becomes numbered parameters', (context) => {
  assert.deepEqual(pgQuery(context, 'await pool.query(`SELECT * FROM accounts WHERE id = ${id}`);').change, {
    before: 'await pool.query(`SELECT * FROM accounts WHERE id = ${id}`);',
    after: "await pool.query('SELECT * FROM accounts WHERE id = $1', [id]);",
  });
  assert.equal(
    pgQuery(
      context,
      "await pool.query(`SELECT * FROM accounts WHERE name = '${name}' AND age >= ${id} LIMIT ${limit}`);",
    ).change.after,
    "await pool.query('SELECT * FROM accounts WHERE name = $1 AND age >= $2 LIMIT $3', [name, id, limit]);",
  );
  assert.equal(
    pgQuery(context, "await pool.query(`SELECT * FROM accounts WHERE status = 'open' AND id = ${id}`);").change.after,
    "await pool.query(`SELECT * FROM accounts WHERE status = 'open' AND id = $1`, [id]);",
  );
});

test('dynamic pg query text with identifiers or unclear positions gets no fix', (context) => {
  for (const line of [
    'await pool.query(`SELECT * FROM ${table} WHERE id = ${id}`);',
    'await pool.query(`SELECT * FROM accounts ORDER BY ${name}`);',
    "await pool.query(`SELECT * FROM accounts WHERE name LIKE '%${name}%'`);",
    'await pool.query(`SELECT * FROM accounts WHERE id IN (${id})`);',
    'await pool.query(`SELECT * FROM accounts WHERE id = ${id}::int`);',
    'await pool.query(`SELECT * FROM accounts WHERE id = $1 AND name = ${name}`, [1]);',
    'await pool.query(`SELECT * FROM accounts WHERE id = $1 AND name = ${name}`);',
    "await pool.query(`SELECT * FROM accounts WHERE note = 'id = ${id}'`);",
    'await pool.query(`SELECT * FROM accounts WHERE data ->> ${name} = 1`);',
    'await pool.query(`UPDATE accounts SET age = ${id}; DELETE FROM accounts`);',
    'await pool.query({ text: `SELECT * FROM accounts WHERE id = ${id}` });',
  ]) {
    const { matching } = pgQuery(context, line);
    assert.equal(matching.filter((finding) => finding.fix).length, 0, line);
  }
});
