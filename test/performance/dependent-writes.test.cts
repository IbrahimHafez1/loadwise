import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import type { FileMap } from '../types/project-files.cjs';

const files = {
  'node_modules/@prisma/client/index.d.ts': `
    export type OrderWhereUniqueInput = { id?: number; slug?: string };
    export type OrderCreateNestedOneWithoutItemsInput = { connect?: OrderWhereUniqueInput };
    export type InputJsonValue = string | number | { [field: string]: InputJsonValue };
    export type ItemCreateInput = { orderId?: number; order?: OrderCreateNestedOneWithoutItemsInput;
      owner?: OrderCreateNestedOneWithoutItemsInput; metadata?: InputJsonValue; message?: string | number };
    export interface OrderDelegate { create(input: object): Promise<{ id: number; handle: string }> }
    export interface ItemDelegate {
      create<T extends { data: ItemCreateInput }>(input: T): Promise<{ id: number }>
      createMany(input: object): Promise<{ count: number }>
    }
    export interface TransactionClient { order: OrderDelegate; item: ItemDelegate }
    export class PrismaClient {
      order: OrderDelegate; item: ItemDelegate;
      $transaction(callback: (tx: TransactionClient) => unknown): Promise<unknown>
    }
  `,
};

function check(source: string, extra: FileMap = {}) {
  return lint(source, { ...files, ...extra }).filter(
    (finding: Finding) => finding.ruleId === 'prisma-dependent-writes',
  );
}

test('dependent writes link adjacent awaited creations through literal relationship data on the same client', () => {
  const findings = check(
    [
      "import { PrismaClient as Client } from '@prisma/client';",
      'const db = new Client();',
      'const alias = db;',
      'const orders = alias.order, items = db.item;',
      'async function first() {',
      '  const order = await orders.create({data: {}});',
      '  // Both writes belong to a single order submission.',
      '  await items.create({data: {orderId: order.id}});',
      '}',
      'async function second(db: Client) {',
      '  const order = (await db.order.create({data: {}}));',
      '  return await db.item.createMany({data: [{order_id: order.id}]});',
      '}',
      'async function third(db: Client) {',
      '  const created = await db.order.create({data: {}});',
      '  const child = await db.item.create({data: {order: {connect: {id: created.id}}}});',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map((finding: Finding) => finding.line),
    [8, 12, 16],
  );
  assert.match(findings[0].message, /If both must succeed or roll back together/);
});

test('nested connect uses its generated relation type with arbitrary key and source field names', () => {
  const findings = check(
    [
      "import { PrismaClient } from '@prisma/client';",
      'async function write(db: PrismaClient) {',
      '  const created = await db.order.create({data: {}});',
      "  await db.item.create({data: {owner: {connect: {'slug': created.handle}}}});",
      '  const logged = await db.order.create({data: {}});',
      '  await db.item.create({data: {metadata: {connect: {slug: logged.handle}}}});',
      '  const recorded = await db.order.create({data: {}});',
      '  await db.item.create({data: {metadata: {connect: {id: recorded.id}}}});',
      '  const mixed = await db.order.create({data: {}});',
      "  await db.item.create({data: {owner: {connect: {id: mixed.id, slug: 'other'}}}});",
      '  const copy = await db.order.create({data: {}});',
      '  await db.item.create({data: {message: copy.handle}});',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map((finding: Finding) => finding.line),
    [4],
  );
  assert.match(findings[0].message, /a value from the preceding/);
});

test('independent, nonadjacent, cross-client, metadata and already-transactional writes stay quiet', () => {
  assert.deepEqual(
    check(`
    import { PrismaClient, type TransactionClient } from '@prisma/client';
    async function independent(db: PrismaClient, other: PrismaClient) {
      const order = await db.order.create({data: {}});
      await db.item.create({data: {orderId: 2}});
      const different = await db.order.create({data: {}});
      await other.item.create({data: {orderId: different.id}});
      const previous = await db.order.create({data: {}});
      console.log(previous.id);
      await db.item.create({data: {orderId: previous.id}});
      const logged = await db.order.create({data: {}});
      await db.item.create({data: {message: logged.id}});
      const overwritten = await db.order.create({data: {}});
      await db.item.create({data: {orderId: overwritten.id, ...{orderId: 2}}});
      const callback = await db.order.create({data: {}});
      setTimeout(async () => { await db.item.create({data: {orderId: callback.id}}); });
      await db.$transaction(async tx => {
        const atomic = await tx.order.create({data: {}});
        await tx.item.create({data: {orderId: atomic.id}});
      });
    }
    async function inExistingTx(tx: TransactionClient) {
      const atomic = await tx.order.create({data: {}});
      await tx.item.create({data: {orderId: atomic.id}});
    }
  `),
    [],
  );
});

test('lookalikes and outer-client usage inside a transaction do not get a new-transaction suggestion', () => {
  assert.deepEqual(
    check(`
    import { PrismaClient as Real } from '@prisma/client';
    class PrismaClient {
      order = { async create(input: object) { return {id: 1}; } };
      item = { async create(input: object) { return {id: 2}; } };
    }
    async function local(db: PrismaClient) {
      const parent = await db.order.create({data: {}});
      await db.item.create({data: {orderId: parent.id}});
    }
    async function usingWrongClient(db: Real) {
      await db.$transaction(async tx => {
        const parent = await db.order.create({data: {}});
        await db.item.create({data: {orderId: parent.id}});
      });
    }
  `),
    [],
  );
});
