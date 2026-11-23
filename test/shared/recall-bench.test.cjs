'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { securityRules } = require('../../lib/security/rule-ids.cjs');
const { knownRules } = require('../../lib/performance/rule-ids.cjs');
const { evaluateCase } = require('../../bench/recall/runner.cjs');

const recallDir = path.resolve(__dirname, '../../bench/recall');
const manifest = JSON.parse(fs.readFileSync(path.join(recallDir, 'manifest.json'), 'utf8'));
const knownRuleIdsByPillar = { sec: new Set(securityRules), perf: new Set(knownRules) };

// The benchmark itself reports misses; this guards the manifest so a typo is never counted as a rule miss.
test('every recall case names a real rule id and a target line inside its file', () => {
  for (const entry of manifest.cases) {
    assert.ok(
      knownRuleIdsByPillar[entry.pillar]?.has(entry.ruleId),
      `${entry.id}: unknown ${entry.pillar} rule ${entry.ruleId}`,
    );
    const source = fs.readFileSync(path.join(recallDir, 'cases', entry.project, entry.file), 'utf8');
    assert.ok(
      entry.line >= 1 && entry.line <= source.split('\n').length,
      `${entry.id}: line ${entry.line} out of range`,
    );
    assert.ok(entry.source, `${entry.id}: missing source reference`);
  }
});

test('recall case ids are unique', () => {
  const ids = manifest.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('evaluateCase matches the rule within one line of the target and rejects other rules', () => {
  const entry = { ruleId: 'open-redirect', file: 'server.ts', line: 10 };
  const finding = { ruleId: 'open-redirect', file: 'cases/app/server.ts', line: 11 };
  assert.equal(evaluateCase(entry, [finding]).matched, true);
  assert.equal(evaluateCase(entry, [{ ...finding, line: 13 }]).matched, false);
  assert.equal(evaluateCase(entry, [{ ...finding, ruleId: 'ssrf-request-url' }]).matched, false);
});
