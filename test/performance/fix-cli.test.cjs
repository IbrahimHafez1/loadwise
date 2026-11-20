'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const bin = path.resolve(__dirname, '../../bin/warden-backend.cjs');
const example = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');

function project(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-fix-cli-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'slow.ts'), example);
  return (args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
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
