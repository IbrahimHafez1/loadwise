import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lint } from './helpers.js';
import { sequelize, mongoose } from './fixtures/schema/orm-stubs.js';
import type { TestContext } from 'node:test';
import type { Finding } from '../../lib/shared/types.js';
import { lineOf } from '../types/finding-fix.js';
const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');

const SCHEMA = `
model User {
  id    Int    @id
  email String
}

model TeamMember {
  id     Int @id
  teamId Int
}
`;

// A cloned monorepo without node_modules: the schema lives in a database package named by
// prisma.config.ts.
function ungeneratedMonorepo(context: TestContext, source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-ungenerated-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  fs.mkdirSync(path.join(root, '.git'));
  write('package.json', JSON.stringify({ name: 'repo', private: true }));
  write('packages/database/package.json', JSON.stringify({ name: '@acme/database' }));
  write('packages/database/prisma.config.ts', "export default { schema: './schema' };\n");
  write('packages/database/schema/main.prisma', SCHEMA);
  write('apps/api/package.json', JSON.stringify({ name: 'api', dependencies: { '@prisma/client': '6.0.0' } }));
  write('apps/api/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'commonjs' }, include: ['src'] }));
  write('apps/api/src/service.ts', source);
  return path.join(root, 'apps/api');
}

function scan(directory: string) {
  const result = spawnSync(process.execPath, [bin, 'perf', '--engine', 'js', '-p', 'tsconfig.json', '--json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  const findings = JSON.parse(result.stdout).findings.filter(
    (finding: Finding) => finding.ruleId === 'prisma-query-in-loop',
  );
  return { stderr: result.stderr, lines: findings.map((finding: Finding) => finding.line) };
}

test('without a generated client, schema model delegates on client-named receivers still feed the Prisma rules', (context) => {
  const source = `import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
class PrismaService extends PrismaClient {}
export class Teams {
  constructor(private readonly prisma: PrismaService) {}
  async owners(teamIds: number[]) {
    for (const teamId of teamIds) {
      await this.prisma.teamMember.count({ where: { teamId } }); // repeat
    }
  }
}
export async function load(ids: number[]) {
  for (const id of ids) {
    await prisma.user.findFirst({ where: { id } }); // repeat
  }
  await prisma.$transaction(async (tx: any) => {
    for (const id of ids) await tx.user.update({ where: { id }, data: {} }); // repeat
  });
}
`;
  const result = scan(ungeneratedMonorepo(context, source));
  const expected = source.split('\n').flatMap((line, index) => (line.includes('// repeat') ? [index + 1] : []));
  assert.deepEqual(result.lines, expected);
  assert.match(
    result.stderr,
    /Note: @prisma\/client is imported but not installed or its client is not generated; its checks run with reduced precision from schema\.prisma model names until `npm install` and `prisma generate`\./,
  );
});

test('the fallback ignores other receiver names, non-model properties, non-Prisma methods and typed objects', (context) => {
  const source = `declare const client: any;
declare const prisma: any;
const db = { user: { findFirst: async (options: object) => options } };
export async function load(ids: number[]) {
  for (const id of ids) {
    await client.user.findFirst({ where: { id } });
    await prisma.invoice.findFirst({ where: { id } });
    await prisma.user.findByEmail({ where: { id } });
    await db.user.findFirst({ where: { id } });
  }
}
`;
  assert.deepEqual(scan(ungeneratedMonorepo(context, source)).lines, []);
});

const listHeader = `import { Model } from 'sequelize';
import { Model as Document } from 'mongoose';
declare class Order extends Model {}
declare class Expense extends Document<unknown> {}
declare const orderId: number, expenseId: string;
`;

function unboundedLines(body: string) {
  const offset = listHeader.split('\n').length - 1;
  return lint(listHeader + body, { ...sequelize, ...mongoose })
    .filter((finding: Finding) => finding.ruleId === 'unbounded-list-query')
    .map((finding: Finding) => lineOf(finding) - offset);
}

test('unbounded-list-query reports Sequelize findAll and Mongoose find returned without a limit', () => {
  const body = `export async function orders(req: unknown, res: { json(value: unknown): void }) {
  res.json(await Order.findAll({ where: { status: 'open' } }));
}
export async function expenses(req: unknown, res: { json(value: unknown): void }) {
  res.json(await Expense.find({ owner: 'x' }).sort({ date: -1 }).lean());
}
export async function quiet(req: unknown, res: { json(value: unknown): void }) {
  res.json({
    paged: await Order.findAll({ where: { status: 'open' }, limit: 20 }),
    one: await Order.findAll({ where: { id: orderId } }),
    grouped: await Order.findAll({ group: ['status'] }),
    limited: await Expense.find({ owner: 'x' }).limit(20),
    pinned: await Expense.find({ _id: expenseId }),
  });
}
`;
  assert.deepEqual(unboundedLines(body), [2, 5]);
});

test('unbounded-list-query follows a handler into a service assigned as an arrow function', () => {
  const body = `export const listOrders = async () => Order.findAll();
export const pagedOrders = async (page: number) => Order.findAll();
export async function orders(req: unknown, res: { json(value: unknown): void }) {
  res.json(await listOrders());
  res.json(await pagedOrders(1));
}
`;
  assert.deepEqual(unboundedLines(body), [1]);
});
