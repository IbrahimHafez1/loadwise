import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const example = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/slow.ts'), 'utf8');

function project(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-fix-cli-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'slow.ts'), example);
  return (args: string[]) => spawnSync(process.execPath, [bin, 'perf', ...args], { cwd: root, encoding: 'utf8' });
}

test('--fix --yes rewrites every fixable finding and the rescan comes back clean', (context) => {
  const run = project(context);
  const fixed = run(['slow.ts', '--fix', '--yes', '--engine', 'js']);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Applied 3 of 3 automatic fix\(es\)\./);
  const rescan = run(['slow.ts', '--json', '--engine', 'js']);
  assert.equal(rescan.status, 0, rescan.stdout);
  assert.deepEqual(JSON.parse(rescan.stdout).findings, []);
});

test('--fix --yes leaves findings below --min-impact unchanged', (context) => {
  const run = project(context);
  const skipped = run(['slow.ts', '--fix', '--yes', '--min-impact', 'high', '--engine', 'js']);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.doesNotMatch(skipped.stdout, /Applied [1-9]/);
  assert.equal(JSON.parse(run(['slow.ts', '--json', '--engine', 'js']).stdout).findings.length, 3);
});

test('--fix without a terminal asks for --yes instead of changing files', (context) => {
  const run = project(context);
  const refused = run(['slow.ts', '--fix', '--engine', 'js']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--fix --yes/);
  assert.equal(refused.stdout, '');
});

test('--fix rejects options that print a report instead', (context) => {
  const run = project(context);
  for (const args of [['--fix', '--json'], ['--yes']]) {
    const result = run(['slow.ts', ...args]);
    assert.equal(result.status, 2, result.stdout);
  }
});
