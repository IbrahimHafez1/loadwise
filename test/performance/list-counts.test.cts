import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import { reasonOf } from '../types/finding-reason.cjs';

const RULE_ID = 'list-count-per-request';
const files = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate {
      findMany(args?: object): Promise<{ id: number }[]>;
      count(args?: object): Promise<number>;
    }
    export declare class PrismaClient { user: UserDelegate }`,
};
const header = `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient, orgId: number, cache: { wrap<T>(key: string, load: () => Promise<T>): Promise<T> };
declare const response: { json(value: unknown): void };
type Request = { query: { withTotal?: string; page?: number } };
`;

function findings(body: string) {
  return lint(header + body, files).filter((finding: Finding) => finding.ruleId === RULE_ID);
}

test('reports a count run alongside an unlimited list query and returned in the response', () => {
  const found = findings(`export async function list(req: Request, res: typeof response) {
    const [rows, total] = await Promise.all([prisma.user.findMany(), prisma.user.count()]);
    res.json({ rows, total });
  }`);
  assert.equal(found.length, 1);
  assert.equal(found[0].contextualReason, undefined);
});

test('a count with the same where as a page-limited list query is contextual; an offset alone is not a page', () => {
  const [paged] = findings(`export async function list(req: Request, res: typeof response) {
    const [rows, total] = await Promise.all([prisma.user.findMany({ take: 10 }), prisma.user.count()]);
    res.json({ rows, total });
  }`);
  assert.match(reasonOf(paged), /same where filter/);
  const [filtered] = findings(`export async function list(req: Request, res: typeof response) {
    const [rows, total] = await Promise.all([
      prisma.user.findMany({ where: { active: true }, take: 10 }),
      prisma.user.count({ where: { active: true } }),
    ]);
    res.json({ rows, total });
  }`);
  assert.match(reasonOf(filtered), /same where filter/);
  const [offsetOnly] = findings(`export async function list(req: Request, res: typeof response) {
    const [rows, total] = await Promise.all([prisma.user.findMany({ skip: 10 }), prisma.user.count()]);
    res.json({ rows, total });
  }`);
  assert.equal(offsetOnly.contextualReason, undefined);
});

test('follows the total through arithmetic into the response', () => {
  assert.equal(
    findings(`export async function list(req: Request, res: typeof response) {
      const rows = await prisma.user.findMany({ take: 10 });
      const total = await prisma.user.count({ where: { active: true } });
      res.json({ rows, pages: Math.ceil(total / 10) });
    }`).length,
    1,
  );
});

test('leaves a serial count then page pair to count-then-page-serial', () => {
  const source = `export async function list(req: Request, res: typeof response) {
    const total = await prisma.user.count({ where: { active: true } });
    const rows = await prisma.user.findMany({ where: { active: true }, take: 10 });
    res.json({ rows, total });
  }`;
  assert.deepEqual(findings(source), []);
  const serial = lint(header + source, files).filter((finding: Finding) => finding.ruleId === 'count-then-page-serial');
  assert.equal(serial.length, 1);
});

test('skips optional, cached and unused counts and handlers that do not page', () => {
  assert.deepEqual(
    findings(`export async function a(req: Request, res: typeof response) {
      const [rows, total] = await Promise.all([
        prisma.user.findMany({ take: 10 }),
        req.query.withTotal ? prisma.user.count() : undefined,
      ]);
      res.json({ rows, total });
    }
    export async function b(req: Request, res: typeof response) {
      const rows = await prisma.user.findMany({ take: 10 });
      const total = await cache.wrap('users', () => prisma.user.count());
      res.json({ rows, total });
    }
    export async function c(req: Request, res: typeof response) {
      const rows = await prisma.user.findMany({ take: 10 });
      const total = await prisma.user.count();
      res.json({ rows, empty: rows.length === 0 && total === 0 });
    }
    export async function d(req: Request, res: typeof response) {
      res.json({ total: await prisma.user.count() });
    }`),
    [],
  );
});

test('makes a count filtered by a parent id contextual', () => {
  const [finding] = findings(`export async function list(req: Request, res: typeof response) {
    const [rows, total] = await Promise.all([
      prisma.user.findMany({ where: { orgId }, take: 10 }),
      prisma.user.count({ where: { orgId } }),
    ]);
    res.json({ rows, total });
  }`);
  assert.ok(finding.contextualReason);
});
