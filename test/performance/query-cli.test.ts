import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileOf } from '../types/finding-fix.js';
import { parseReport } from '../types/cli-report.js';
import type { CliReport } from '../types/cli-report.js';
import * as nativeRuntime from '../../lib/performance/native-runtime.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const policyName = 'loadwise.config.json';
const rawPolicyName = 'scope.json';
const scopeRule = 'prisma-scope-unverified';
const requirement = { field: 'tenantId', from: '@app/auth', export: 'requireAuthorizedTenantId' };
const rawPolicyFor = (model: string) => JSON.stringify({ prismaScopes: { [model]: requirement } });
const policyFor = (model: string) => JSON.stringify({ performance: { prismaScopes: { [model]: requirement } } });
const config = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, types: [] },
  files: ['reads.ts', 'perf.ts'],
});

function project(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-query-'));
  const files = new Set<string>();
  const folders = new Set<string>();
  function write(name: string, contents: string) {
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

function run(root: string, args: readonly string[], command = 'perf') {
  return spawnSync(process.execPath, [bin, command, ...args, '--json'], { cwd: root, encoding: 'utf8' });
}

function checked(root: string, args: readonly string[], expectedExit: number, command = 'perf') {
  const result = run(root, args, command);
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  return parseReport(result.stdout);
}

// [file name, line, rule id] of a finding.
type Location = [string, number | undefined, string];

function locations(result: CliReport): Location[] {
  return result.findings.map((finding): Location => [path.basename(fileOf(finding)), finding.line, finding.ruleId]);
}

const expectedProject: Location[] = [
  ['perf.ts', 1, 'array-repeated-membership'],
  ['reads.ts', 4, scopeRule],
];

// The scope rules are security rules; the performance checker reads the same policy file for its
// own sections.
test('query policy discovery follows project configuration or the explicit-file working directory', (context) => {
  const { root, write } = project(context);
  write('app/' + policyName, policyFor('Invoice'));
  write(policyName, policyFor('Ledger'));
  write('app/' + rawPolicyName, rawPolicyFor('Invoice'));
  write(rawPolicyName, rawPolicyFor('Ledger'));
  assert.deepEqual(locations(checked(root, ['-p', 'app/tsconfig.json'], 1)), [expectedProject[0]]);
  assert.deepEqual(locations(checked(root, ['-p', 'app/tsconfig.json'], 1, 'sec')), [expectedProject[1]]);
  assert.deepEqual(checked(root, ['app/reads.ts'], 0, 'sec').findings, []);
  const explicitFile = checked(root, ['app/reads.ts', '--policy', 'app/' + rawPolicyName], 1, 'sec');
  assert.deepEqual(locations(explicitFile), [expectedProject[1]]);
  assert.deepEqual(checked(root, ['-p', 'app', '--policy', rawPolicyName], 0, 'sec').findings, []);
});

test('opting out preserves existing performance checks and malformed policy files stop analysis', (context) => {
  const { root, write } = project(context);
  assert.deepEqual(locations(checked(root, ['-p', 'app'], 1)), [expectedProject[0]]);
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
  if (!nativeSkip) nativeRuntime.executable();
} catch {
  nativeSkip = 'optional native compiler is absent';
}

test('the native CLI agrees with the default engine on opted-in scope findings', { skip: nativeSkip }, (context) => {
  const { root, write } = project(context);
  write('app/' + policyName, policyFor('Invoice'));
  const args = ['-p', 'app'];
  const stable = checked(root, args, 1, 'sec');
  assert.deepEqual(locations(stable), [expectedProject[1]]);
  const native = checked(root, ['--native', ...args], 1, 'sec');
  assert.equal(native.skippedFiles, undefined);
  assert.deepEqual(native.findings, stable.findings);
  const missing = run(root, ['--native', ...args, '--policy', 'missing.json'], 'sec');
  assert.equal(missing.status, 2, missing.stdout || missing.stderr);
});

async function exerciseWatch(context: TestContext, explicit: boolean) {
  const { root, write } = project(context);
  const filename = explicit ? rawPolicyName : 'app/' + policyName;
  const contentsFor = explicit ? rawPolicyFor : policyFor;
  write(filename, contentsFor('Ledger'));
  const args = [bin, 'perf', '--watch', '--json', '-p', 'app'];
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
  async function nextLine(transition: string) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        lines.next(),
        new Promise<never>((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('No watch response after ' + transition)), transitionTimeout);
        }),
      ]);
      assert.ok(!result.done, 'watch exited before it reported a policy change');
      return result.value;
    } finally {
      clearTimeout(timeout);
    }
  }
  async function expectSnapshot(expected: Location[], transition: string) {
    const line = await nextLine(transition);
    assert.ok(line.startsWith('{'), line);
    assert.deepEqual(locations(parseReport(line)), expected);
  }
  try {
    await expectSnapshot([expectedProject[0]], 'initial startup');
    write(filename, contentsFor('Invoice'));
    await expectSnapshot([expectedProject[0]], 'enabling the Invoice policy');
    write(filename, '{');
    const invalid = await nextLine('invalid JSON');
    assert.ok(invalid.trim() && !invalid.startsWith('{'), invalid);
    write(filename, contentsFor('Ledger'));
    await expectSnapshot([expectedProject[0]], 'recovering the Ledger policy');
    fs.unlinkSync(path.join(root, filename));
    const deleted = await nextLine('deleting the existing policy');
    assert.ok(deleted.trim() && !deleted.startsWith('{'), deleted);
    write(filename, contentsFor('Invoice'));
    await expectSnapshot([expectedProject[0]], 'restoring the deleted policy');
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
