'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const rule = 'await-before-early-exit';
const prismaStub = `export interface User { id: string; name: string }
export interface UserDelegate {
  findUnique(args: object): Promise<User | null>;
  findUniqueOrThrow(args: object): Promise<User>;
  findMany(args?: object): Promise<User[]>;
  update(args: object): Promise<User>;
}
export declare class PrismaClient { user: UserDelegate }`;
const files = { 'node_modules/@prisma/client/index.d.ts': prismaStub };
const header = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
declare function audit(id: string): Promise<void>;
declare function plain(): boolean;
`;

function reported(body, extra = {}) {
  return lint(header + body, { ...files, ...extra }).filter((finding) => finding.ruleId === rule);
}

test('a read whose result the next guard never uses is reported', () => {
  const [finding] = reported(`export async function rename(id: string, name: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!name) throw new Error('name required');
  return { user, name };
}`);
  assert.equal(finding.line, 6);
  assert.match(finding.message, /^The guard right after this await returns or throws without using what the call read/);
});

test('an unassigned read and a bare return guard are reported too', () => {
  assert.equal(
    reported(`export async function warm(id: string, skip: boolean) {
  await prisma.user.findMany({ where: { id } });
  if (skip) return;
  return 1;
}`).length,
    1,
  );
});

test('a guard that uses the read, anything derived from it, or an else branch is quiet', () => {
  const body = (statements) => `export async function run(id: string, name: string) {\n${statements}\n}`;
  assert.deepEqual(
    reported(
      body(`  const user = await prisma.user.findUnique({ where: { id } });\n  if (!user) throw new Error('missing');`),
    ),
    [],
  );
  assert.deepEqual(
    reported(
      body(
        `  const { name: stored } = await prisma.user.findUnique({ where: { id } }) as any;\n  if (stored === name) return;`,
      ),
    ),
    [],
  );
  assert.deepEqual(
    reported(
      body(
        `  const user = await prisma.user.findUnique({ where: { id } });\n  if (name) return user; else name.length;`,
      ),
    ),
    [],
  );
  assert.deepEqual(
    reported(body(`  let user;\n  user = await prisma.user.findUnique({ where: { id } });\n  if (user) return 1;`)),
    [],
  );
});

test('writes, OrThrow reads, non-ORM calls and a guard that is not the very next statement are quiet', () => {
  const body = (statements) => `export async function run(id: string, name: string) {\n${statements}\n}`;
  assert.deepEqual(
    reported(body(`  await prisma.user.update({ where: { id }, data: {} });\n  if (!name) return;`)),
    [],
  );
  assert.deepEqual(
    reported(body(`  await prisma.user.findUniqueOrThrow({ where: { id } });\n  if (!name) return;`)),
    [],
  );
  assert.deepEqual(reported(body(`  await audit(id);\n  if (!name) return;`)), []);
  assert.deepEqual(
    reported(
      body(
        `  const user = await prisma.user.findUnique({ where: { id } });\n  console.log(user);\n  if (!name) return;`,
      ),
    ),
    [],
  );
});

test('a guard that awaits, or one that does not exit, is quiet', () => {
  const body = (statements) => `export async function run(id: string, name: string) {\n${statements}\n}`;
  assert.deepEqual(reported(body(`  await prisma.user.findMany({});\n  if (await audit(id)) return;`)), []);
  assert.deepEqual(reported(body(`  await prisma.user.findMany({});\n  if (!name) { console.log(1); }`)), []);
});

test('fetch and axios.get count as reads, a POST does not', () => {
  const found = (call) =>
    lint(`export async function run(skip: boolean) {\n  await ${call};\n  if (skip) return;\n}`).filter(
      (finding) => finding.ruleId === rule,
    );
  assert.equal(found("fetch('https://example.com/a')").length, 1);
  assert.equal(found("fetch('https://example.com/a', { method: 'POST' })").length, 0);
});

function fixFor(context, body) {
  const { findings } = scanWithFixes(context, {
    ...files,
    'a.ts': `${header}export async function run(id: string, name: string) {\n${body}\n}`,
  });
  return findings.find((finding) => finding.ruleId === rule);
}

test('the fix swaps the guard above the await when the guard only reads parameters', (context) => {
  const finding = fixFor(
    context,
    `  const user = await prisma.user.findUnique({ where: { id } });
  if (!name) throw new Error('name required');
  return user;`,
  );
  const { before, after } = onlyChange(finding);
  const read = 'const user = await prisma.user.findUnique({ where: { id } });';
  const guard = "if (!name) throw new Error('name required');";
  assert.equal(before, `${read}\n${guard}`);
  assert.equal(after, `${guard}\n${read}`);
});

test('the fix may read constants declared before the await', (context) => {
  const finding = fixFor(
    context,
    `  const limit = 5;
  const user = await prisma.user.findUnique({ where: { id } });
  if (name.length > limit) return null;
  return user;`,
  );
  assert.ok(onlyChange(finding));
});

test('the fix is withheld when the guard calls, reads a later const or a let, or writes', (context) => {
  const guards = [
    ['if (plain()) return null;', ''],
    ['if (later) return null;', ''],
    ['if (flag) return null;', '  let flag = false;\n'],
    ['if (name === (id = name)) return null;', ''],
  ];
  for (const [guard, declarations] of guards) {
    const { findings } = scanWithFixes(context, {
      ...files,
      'a.ts': `${header}export async function run(id: string, name: string) {
${declarations}  const user = await prisma.user.findUnique({ where: { id } });
  ${guard}
  const later = true;
  return user;
}`,
    });
    const finding = findings.find((entry) => entry.ruleId === rule);
    assert.ok(finding, guard);
    assert.equal(finding.fix, undefined, guard);
  }
});
