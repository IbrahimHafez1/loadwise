import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
const cli = path.join(__dirname, '../../bin/loadwise.cjs');

function runInWorkspace(context: TestContext, source: string, ...args: string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-text-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'ledger.ts'), source);
  return spawnSync(process.execPath, [cli, 'maint', ...args], { cwd: directory, encoding: 'utf8' });
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
  // The two findings share one reason, so it prints once above their two locations.
  assert.match(result.stdout, /^\[query-mutates-state\] \w+: .*\(2 findings\)$/m);
  assert.equal(result.stdout.match(/^ {2}\S+:\d+:\d+ #\w+$/gm)?.length, 2);
  assert.equal(result.stdout.split('  Fix:').length - 1, 1);
  assert.match(result.stdout, /    - \/\*\* @maintainabilityQuery \*\//);
  assert.match(result.stdout, /    \+ current\(\) \{ return this\.count; \}/);
});

test('JSON findings keep their fields and gain an additive example', (context) => {
  const result = runInWorkspace(context, twoMutatingQueries, '--json');
  const { findings } = JSON.parse(result.stdout);
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.equal(finding.ruleId, 'query-mutates-state');
    assert.match(finding.message, /@maintainabilityQuery/);
    assert.deepEqual(Object.keys(finding.example), ['before', 'after']);
  }
});
