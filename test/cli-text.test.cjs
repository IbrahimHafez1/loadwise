'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const test = require('node:test');
const cli = path.join(__dirname, '../bin/maintainability-check.cjs');

function runInWorkspace(context, source, ...args) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-text-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'ledger.ts'), source);
  return spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' });
}

const twoMutatingQueries = [
  'export class Ledger { balance = 0;',
  '/** @maintainabilityQuery */',
  'first() { this.balance++; return this.balance; }',
  '/** @maintainabilityQuery */',
  'second() { this.balance--; return this.balance; } }',
].join('\n');

test('text output prints the Fix block once per rule', (context) => {
  const result = runInWorkspace(context, twoMutatingQueries);
  const findingLines = result.stdout.split('\n').filter((line) => line.includes('[query-mutates-state]'));
  assert.equal(findingLines.length, 2);
  assert.equal(result.stdout.split('  Fix:').length - 1, 1);
  assert.match(result.stdout, /    - \/\*\* @maintainabilityQuery \*\//);
  assert.match(result.stdout, /    \+ current\(\) \{ return this\.count; \}/);
});
