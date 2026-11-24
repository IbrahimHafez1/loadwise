import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import { lineOf } from '../types/finding-fix.cjs';

const RULE_ID = 'unbounded-list-query';
const files = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate {
      findMany(args?: object): Promise<{ id: number }[]>;
    }
    export declare class PrismaClient { user: UserDelegate }`,
};
const header = `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
declare const response: { json(value: unknown): void; send(value: unknown): void };
declare function exportToExcel(res: unknown, rows: unknown[]): Promise<void>;
declare function buildPdfReport(rows: unknown[]): Buffer;
declare function summarize(rows: unknown[]): number;
type Request = { body: { ids: number[] } };
class Service {
  byIds(ids: number[]) { return prisma.user.findMany({ where: { id: { in: ids } } }); }
  byCappedIds(ids: number[]) {
    if (ids.length > 100) throw new Error('too many');
    return prisma.user.findMany({ where: { id: { in: ids } } });
  }
}
declare const svc: Service;
`;

function findings(body: string) {
  return lint(header + body, files).filter((finding: Finding) => finding.ruleId === RULE_ID);
}

test('an id list that a handler passes uncapped to a service method is reported on the handler call', () => {
  const found = findings(`export async function list(req: Request, res: typeof response) {
    res.json(await svc.byIds(req.body.ids));
  }`);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /id list/);
  assert.ok(found[0].contextualReason);
});

test('a service id list stays quiet when it is capped in the handler or the method, or is not request input', () => {
  assert.deepEqual(
    findings(`export async function capped(req: Request, res: typeof response) {
      if (req.body.ids.length > 100) return;
      res.json(await svc.byIds(req.body.ids));
    }
    export async function cappedInService(req: Request, res: typeof response) {
      res.json(await svc.byCappedIds(req.body.ids));
    }
    export async function fixed(req: Request, res: typeof response) {
      res.json(await svc.byIds([1, 2, 3]));
    }
    export async function unreturned(req: Request, res: typeof response) {
      await svc.byIds(req.body.ids);
      res.json('ok');
    }`),
    [],
  );
});

test('rows passed to an export helper reach the response', () => {
  const body = `export async function excel(req: Request, res: typeof response) {
    const rows = await prisma.user.findMany();
    await exportToExcel(res, rows);
  }
  export async function pdf(req: Request, res: typeof response) {
    res.send(buildPdfReport(await prisma.user.findMany()));
  }
  export async function summary(req: Request, res: typeof response) {
    res.json(summarize(await prisma.user.findMany()));
  }`;
  const headerLines = header.split('\n').length - 1;
  assert.deepEqual(
    findings(body).map((finding: Finding) => lineOf(finding) - headerLines),
    [2, 6],
  );
});
