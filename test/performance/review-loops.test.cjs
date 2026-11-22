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
