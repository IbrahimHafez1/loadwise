import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { explainRule } from '../../lib/shared/explain.cjs';
import { registeredRuleIds } from '../../lib/shared/pillars.cjs';
import type * as PackageManifest from '../../package.json';

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('every registered rule has an offline explanation and default impact', () => {
  for (const ruleId of registeredRuleIds()) {
    const [title, description] = explainRule(ruleId).split('\n');
    assert.ok(title.startsWith(ruleId + ' ('), ruleId);
    assert.match(title, /default impact (low|medium|high|critical)\)$/);
    assert.ok(description.trim(), ruleId);
  }
  assert.match(explainRule('python-copy-growing-list'), /append/);
});

test('CLI explains a rule, identifies an unknown rule and prints the installed version', () => {
  const example = run('explain', 'array-repeated-membership');
  assert.equal(example.status, 0, example.stderr);
  assert.match(example.stdout, /new Set/);
  for (const args of [[], ['unknown-rule'], ['constructor'], ['one', 'two']]) {
    const invalid = run('explain', ...args);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Usage:|Unknown rule/);
  }
  const version = run('--version');
  assert.equal(version.status, 0);
  const packageManifest: typeof PackageManifest = require('../../package.json');
  assert.equal(version.stdout.trim(), packageManifest.version);
});
