'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const prismaFiles = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate { findMany(args?: object): Promise<{ id: number }[]>; }
    export declare class PrismaClient { user: UserDelegate }`,
};
const header = `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient, cached: { id: number }[] | undefined;
declare const response: { json(value: unknown): void };
`;

function unboundedFindings(body) {
  return lint(header + body, prismaFiles).filter((finding) => finding.ruleId === 'unbounded-list-query');
}

test('reaches the response through the right operand of a fallback expression', () => {
  assert.equal(
    unboundedFindings(`export async function list(req: unknown, res: typeof response) {
      return cached ?? (await prisma.user.findMany());
    }`).length,
    1,
  );
  assert.equal(
    unboundedFindings(`export async function list(req: unknown, res: typeof response) {
      const rows = cached || (await prisma.user.findMany());
      res.json(rows);
    }`).length,
    1,
  );
});

test('does not treat the right operand of a comparison as the response value', () => {
  assert.equal(
    unboundedFindings(`export async function list(req: unknown, res: typeof response) {
      return 3 > (await prisma.user.findMany()).length;
    }`).length,
    0,
  );
});

const loopFiles = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate { findUnique(options: object): Promise<{ id: number } | null> }
    export declare class PrismaClient { user: UserDelegate }`,
};
const loopHeader = `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient, ids: number[], cache: Map<string, unknown>;
class UserService { async load(id: number) { return prisma.user.findUnique({ where: { id } }); } }
declare const users: UserService;
`;

function loopRules(body) {
  return lint(loopHeader + body, loopFiles)
    .filter((finding) => finding.ruleId === 'prisma-query-in-loop' || finding.ruleId === 'service-query-in-loop')
    .map((finding) => finding.ruleId);
}

test('a cache-miss branch around the loop does not memoise the per-item query inside it', () => {
  assert.deepEqual(
    loopRules(`export async function warm(key: string) {
      if (!cache.has(key)) {
        const rows = [];
        for (const id of ids) rows.push(await prisma.user.findUnique({ where: { id } }));
        cache.set(key, rows);
      }
    }`),
    ['prisma-query-in-loop'],
  );
  assert.deepEqual(
    loopRules(`export async function warm() {
      for (const id of ids) {
        const key = String(id);
        if (!cache.has(key)) cache.set(key, await prisma.user.findUnique({ where: { id } }));
      }
    }`),
    [],
  );
});

test('a service call per item of a list grown inside the loop is reported', () => {
  assert.deepEqual(
    loopRules(`export async function walk(root: number) {
      const pending = [root];
      for (const id of pending) {
        const row = await users.load(id);
        if (row) pending.push(row.id + 1);
      }
    }`),
    ['service-query-in-loop'],
  );
  assert.deepEqual(
    loopRules(`const roots = [1, 2];
    export async function walk() { for (const id of roots) await users.load(id); }`),
    [],
  );
});
