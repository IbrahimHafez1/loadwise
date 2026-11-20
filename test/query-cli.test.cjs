'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const bin = path.resolve(__dirname, '../bin/warden-backend.cjs');
const policyName = 'backend-perf.policy.json';
const scopeRule = 'prisma-scope-unverified';
const requirement = { field: 'tenantId', from: '@app/auth', export: 'requireAuthorizedTenantId' };
const policyFor = (model) => JSON.stringify({ prismaScopes: { [model]: requirement } });
const config = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, types: [] },
  files: ['reads.ts', 'perf.ts'],
});

function project(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-query-'));
  const files = new Set();
  const folders = new Set();
  function write(name, contents) {
    const filename = path.join(root, name);
    for (let directory = path.dirname(filename); directory !== root; directory = path.dirname(directory)) {
      folders.add(directory);
    }
    files.add(filename);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  context.after(() => {
    for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const folder of [...folders].sort((left, right) => right.length - left.length)) fs.rmdirSync(folder);
    fs.rmdirSync(root);
  });
  write('app/tsconfig.json', config);
  write('node_modules/@app/auth/index.d.ts', 'export declare function requireAuthorizedTenantId(): string;');
  write('node_modules/@prisma/client/index.d.ts', "export * from '.prisma/client';");
  write(
    'node_modules/.prisma/client/index.d.ts',
    [
      'export interface InvoiceDelegate { findMany(args?: { where?: { tenantId: string } }): Promise<unknown[]> }',
      'export declare class PrismaClient { invoice: InvoiceDelegate }',
    ].join('\n'),
  );
  write(
    'app/reads.ts',
    [
      "import type { PrismaClient } from '@prisma/client';",
      "import { requireAuthorizedTenantId as tenant } from '@app/auth';",
      'export function scoped(db: PrismaClient) { return db.invoice.findMany({ where: { tenantId: tenant() } }); }',
      'export function unscoped(db: PrismaClient) { return db.invoice.findMany(); }',
    ].join('\n'),
  );
  write(
    'app/perf.ts',
    'export async function select(ids: string[], db: { find(): Promise<string[]> }) { const allowed = await db.find(); return ids.filter(id => allowed.includes(id)); }',
  );
  return { root, write };
}

function run(root, args) {
  return spawnSync(process.execPath, [bin, ...args, '--json'], { cwd: root, encoding: 'utf8' });
}

function checked(root, args, expectedExit) {
  const result = run(root, args);
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function locations(result) {
  return result.findings.map(({ file, line, ruleId }) => [path.basename(file), line, ruleId]);
}

const expectedProject = [
  ['perf.ts', 1, 'array-repeated-membership'],
  ['reads.ts', 4, scopeRule],
];

test('query policy discovery follows project configuration or the explicit-file working directory', (context) => {
  const { root, write } = project(context);
  write('app/' + policyName, policyFor('Invoice'));
  write(policyName, policyFor('Ledger'));
  assert.deepEqual(locations(checked(root, ['-p', 'app/tsconfig.json'], 1)), expectedProject);
  assert.deepEqual(checked(root, ['app/reads.ts'], 0).findings, []);
  const explicitFile = checked(root, ['app/reads.ts', '--policy', 'app/' + policyName], 1);
  assert.deepEqual(locations(explicitFile), [expectedProject[1]]);
  assert.deepEqual(locations(checked(root, ['-p', 'app', '--policy', policyName], 1)), [expectedProject[0]]);
});

test('opting out preserves existing performance checks and malformed policy files stop analysis', (context) => {
  const { root, write } = project(context);
  assert.deepEqual(locations(checked(root, ['-p', 'app'], 1)), [expectedProject[0]]);
  write('app/' + policyName, policyFor('Invoice'));
  write('broken.json', '{');
  write('wrong-shape.json', JSON.stringify({ prismaScopes: [] }));
  for (const filename of ['missing.json', 'broken.json', 'wrong-shape.json']) {
    const result = run(root, ['-p', 'app', '--policy', filename]);
    assert.equal(result.status, 2, result.stdout || result.stderr);
    assert.ok(result.stderr.trim());
    assert.equal(result.stdout.trim(), '');
  }
  write('app/' + policyName, '[');
  const invalidAuto = run(root, ['-p', 'app']);
  assert.equal(invalidAuto.status, 2, invalidAuto.stdout || invalidAuto.stderr);
  assert.equal(invalidAuto.stdout.trim(), '');
});

const [major, minor] = process.versions.node.split('.').map(Number);
let nativeSkip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!nativeSkip) require('../lib/native-runtime.cjs').executable();
} catch {
  nativeSkip = 'optional native compiler is absent';
}

test('the native CLI agrees with the default engine on opted-in scope findings', { skip: nativeSkip }, (context) => {
  const { root, write } = project(context);
  write('app/' + policyName, policyFor('Invoice'));
  const args = ['-p', 'app'];
  const stable = checked(root, args, 1);
  assert.deepEqual(locations(stable), expectedProject);
  assert.deepEqual(checked(root, ['--native', ...args], 1), stable);
  const missing = run(root, ['--native', ...args, '--policy', 'missing.json']);
  assert.equal(missing.status, 2, missing.stdout || missing.stderr);
});

async function exerciseWatch(context, explicit) {
  const { root, write } = project(context);
  const filename = explicit ? 'scope.json' : 'app/' + policyName;
  if (explicit) write(filename, policyFor('Ledger'));
  const args = [bin, '--watch', '--json', '-p', 'app'];
  if (explicit) args.push('--policy', filename);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  const combined = new PassThrough();
  child.stdout.pipe(combined, { end: false });
  child.stderr.pipe(combined, { end: false });
  child.once('close', () => combined.end());
  // Bound each transition so a missing file watcher cannot leave a test child running.
  const transitionTimeout = 10_000;
  const reader = createInterface({ input: combined, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  async function nextLine(transition) {
    let timeout;
    try {
      const result = await Promise.race([
        lines.next(),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('No watch response after ' + transition)), transitionTimeout);
        }),
      ]);
      assert.ok(!result.done, 'watch exited before it reported a policy change');
      return result.value;
    } finally {
      clearTimeout(timeout);
    }
  }
  async function expectSnapshot(expected, transition) {
    const line = await nextLine(transition);
    assert.ok(line.startsWith('{'), line);
    assert.deepEqual(locations(JSON.parse(line)), expected);
  }
  try {
    await expectSnapshot([expectedProject[0]], 'initial startup');
    write(filename, policyFor('Invoice'));
    await expectSnapshot(expectedProject, 'enabling the Invoice policy');
    write(filename, '{');
    const invalid = await nextLine('invalid JSON');
    assert.ok(invalid.trim() && !invalid.startsWith('{'), invalid);
    write(filename, policyFor('Ledger'));
    await expectSnapshot([expectedProject[0]], 'recovering the Ledger policy');
    fs.unlinkSync(path.join(root, filename));
    const deleted = await nextLine('deleting the existing policy');
    assert.ok(deleted.trim() && !deleted.startsWith('{'), deleted);
    write(filename, policyFor('Invoice'));
    await expectSnapshot(expectedProject, 'restoring the deleted policy');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    reader.close();
  }
}

test(
  'watch discovers an added policy and recovers from edits, parse errors and deletion',
  { timeout: 40_000 },
  (context) => exerciseWatch(context, false),
);
test('watch follows changes to an explicit policy outside the source directory', { timeout: 40_000 }, (context) =>
  exerciseWatch(context, true),
);
