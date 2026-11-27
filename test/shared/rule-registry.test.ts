import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pillarOfRule, pillarOrder, rulesByPillar } from '../../lib/shared/rule-registry.js';
import { polyglotRules } from '../../lib/reliability/rule-ids.js';

const root = path.resolve(import.meta.dirname, '../..');

// Every id the pillar's impact table lists, which covers its known rules and its standalone ones.
function idsOf(pillar: (typeof pillarOrder)[number]): string[] {
  return Object.keys(rulesByPillar[pillar].impactByRule);
}

function polyglotIds(directory: string): string[] {
  const rules = path.join(root, 'polyglot', directory, 'rules');
  if (!fs.existsSync(rules)) return [];
  return (
    fs
      .readdirSync(rules)
      // input.yml holds parse and compatibility probes that mark skipped files, not findings.
      .filter((file) => file !== 'input.yml')
      .flatMap((file) => [...fs.readFileSync(path.join(rules, file), 'utf8').matchAll(/^id: (\S+)$/gm)])
      .map((match) => match[1])
  );
}

test('no rule id belongs to two pillars', () => {
  const owners = new Map<string, string[]>();
  for (const pillar of pillarOrder) {
    for (const ruleId of idsOf(pillar)) owners.set(ruleId, [...(owners.get(ruleId) ?? []), pillar]);
  }
  const shared = [...owners].filter(([, pillars]) => pillars.length > 1);
  assert.deepEqual(shared, []);
});

test('every known rule has an impact in its own pillar', () => {
  for (const pillar of pillarOrder) {
    for (const ruleId of rulesByPillar[pillar].knownRules) {
      assert.equal(pillarOfRule(ruleId), pillar, ruleId);
    }
  }
});

test('every contract rule is one of its pillar rules', () => {
  for (const pillar of pillarOrder) {
    for (const ruleId of rulesByPillar[pillar].contractRules) assert.equal(pillarOfRule(ruleId), pillar, ruleId);
  }
});

test('each polyglot rule set reports only its own pillar rules', () => {
  for (const pillar of ['performance', 'reliability', 'security'] as const) {
    for (const ruleId of polyglotIds(pillar)) assert.equal(pillarOfRule(ruleId), pillar, ruleId);
  }
  assert.deepEqual(polyglotIds('reliability').sort(), [...polyglotRules].sort());
});

test('reliability owns the rules it took from performance and maintainability', () => {
  for (const ruleId of [
    'floating-promise',
    'http-call-without-timeout',
    'pg-transaction-on-pool',
    'webhook-missing-idempotency-check',
    'swallowed-error',
    'sql-insert-truncated-at-semicolon',
    'csharp-async-void',
  ]) {
    assert.equal(pillarOfRule(ruleId), 'reliability', ruleId);
  }
  assert.ok(idsOf('reliability').some((ruleId) => ruleId.startsWith('migration-')));
  assert.ok(idsOf('reliability').some((ruleId) => ruleId.startsWith('api-')));
});
