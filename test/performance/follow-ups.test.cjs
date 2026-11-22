'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const RULE_ID = 'unbounded-list-query';
const files = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate {
      findMany(args?: object): Promise<{ id: number }[]>;
    }
    export declare class PrismaClient { user: UserDelegate }`,
  'node_modules/pg/index.d.ts':
    'export class Pool { query(text: string, values?: unknown[]): Promise<{ rows: object[] }>; }',
};
const header = `import type { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
declare const prisma: PrismaClient, pool: Pool, ids: number[];
declare const response: { json(value: unknown): void };
type Request = { body: { ids: number[] } };
`;

function findings(body) {
  return lint(header + body, files).filter((finding) => finding.ruleId === RULE_ID);
}

test('a query filtered by an id list that is not request input is bounded by the list', () => {
  assert.deepEqual(
    findings(`export async function list(req: Request, res: typeof response) {
      res.json(await prisma.user.findMany({ where: { id: { in: ids } } }));
    }
    export async function sql(req: Request, res: typeof response) {
      res.json(await pool.query('SELECT * FROM users WHERE id = ANY($1)', [ids]));
    }`),
    [],
  );
});

test('an id list taken straight from the request body is contextual', () => {
  const [finding] = findings(`export async function list(req: Request, res: typeof response) {
    res.json(await prisma.user.findMany({ where: { id: { in: req.body.ids } } }));
  }`);
  assert.ok(finding.contextualReason);
  assert.match(finding.message, /id list/);
});

test('a request id list with a visible length check is quiet', () => {
  assert.deepEqual(
    findings(`export async function list(req: Request, res: typeof response) {
      const { ids: requested } = req.body;
      if (requested.length > 100) return;
      res.json(await prisma.user.findMany({ where: { id: { in: requested } } }));
    }`),
    [],
  );
});

test('a query with no id filter is still reported', () => {
  assert.equal(
    findings(`export async function list(req: Request, res: typeof response) {
      res.json(await prisma.user.findMany({ where: { name: { in: ['a'] } } }));
    }`).length,
    1,
  );
});
