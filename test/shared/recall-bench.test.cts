import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { securityRules } from '../../lib/security/rule-ids.cjs';
import { knownRules } from '../../lib/performance/rule-ids.cjs';
import type { Finding, Pillar } from '../../lib/shared/types.cjs';
import { evaluateCase } from '../../bench/recall/runner.cjs';

interface ManifestCase {
  id: string;
  project: string;
  pillar: Pillar;
  ruleId: string;
  file: string;
  line: number;
  source?: string;
}

interface RecallManifest {
  cases: ManifestCase[];
}

const recallDir = path.resolve(__dirname, '../../bench/recall');
const manifest: RecallManifest = JSON.parse(fs.readFileSync(path.join(recallDir, 'manifest.json'), 'utf8'));
const knownRuleIdsByPillar: Partial<Record<Pillar, Set<string>>> = {
  sec: new Set(securityRules),
  perf: new Set(knownRules),
};

// The benchmark itself reports misses; this guards the manifest so a typo is never counted as a
// rule miss.
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
  const entry: ManifestCase = {
    id: 'case',
    project: 'app',
    pillar: 'sec',
    ruleId: 'open-redirect',
    file: 'server.ts',
    line: 10,
  };
  const finding: Finding = { ruleId: 'open-redirect', file: 'cases/app/server.ts', line: 11, message: '' };
  assert.equal(evaluateCase(entry, [finding]).matched, true);
  assert.equal(evaluateCase(entry, [{ ...finding, line: 13 }]).matched, false);
  assert.equal(evaluateCase(entry, [{ ...finding, ruleId: 'ssrf-request-url' }]).matched, false);
});
