'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { explainRule } = require('../../lib/shared/explain.cjs');
const { registeredRuleIds } = require('../../lib/shared/pillars.cjs');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

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
  assert.equal(version.stdout.trim(), require('../../package.json').version);
});
