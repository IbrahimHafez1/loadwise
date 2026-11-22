'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lint } = require('./helpers.cjs');
const { sequelize, mongoose } = require('./fixtures/schema/orm-stubs.cjs');
const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');

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

// A cloned monorepo without node_modules: the schema lives in a database package named by prisma.config.ts.
function ungeneratedMonorepo(context, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-ungenerated-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
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

function scan(directory) {
  const result = spawnSync(process.execPath, [bin, 'perf', '--engine', 'js', '-p', 'tsconfig.json', '--json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  const findings = JSON.parse(result.stdout).findings.filter((finding) => finding.ruleId === 'prisma-query-in-loop');
  return { stderr: result.stderr, lines: findings.map((finding) => finding.line) };
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

function unboundedLines(body) {
  const offset = listHeader.split('\n').length - 1;
  return lint(listHeader + body, { ...sequelize, ...mongoose })
    .filter((finding) => finding.ruleId === 'unbounded-list-query')
    .map((finding) => finding.line - offset);
}

