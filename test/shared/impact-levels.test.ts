import assert from 'node:assert/strict';
import test from 'node:test';
import type { Finding, ImpactLevel } from '../../lib/shared/types.js';
import {
  impactLevels,
  parseMinImpact,
  annotateImpact,
  filterMinImpact,
  sortByImpactWithinFiles,
} from '../../lib/shared/impact-levels.js';

const impactByRule: Record<string, ImpactLevel> = { a: 'low', b: 'critical', c: 'medium', d: 'high' };
const finding = (file: string, ruleId: string): Finding => ({ file, ruleId, message: '' });

test('levels run from low to critical', () => {
  assert.deepEqual(impactLevels, ['low', 'medium', 'high', 'critical']);
});

test('parseMinImpact accepts a level, passes undefined through and rejects anything else', () => {
  assert.equal(parseMinImpact('high'), 'high');
  assert.equal(parseMinImpact(undefined), undefined);
  assert.throws(() => parseMinImpact('severe'), /--min-impact must be one of low, medium, high, critical/);
});

test('annotateImpact sets impactLevel from the rule table', () => {
  const findings = annotateImpact([finding('x.ts', 'b'), finding('x.ts', 'a')], impactByRule);
  assert.deepEqual(
    findings.map(({ impactLevel }) => impactLevel),
    ['critical', 'low'],
  );
});

test('filterMinImpact keeps findings at or above the level', () => {
  const findings = annotateImpact(
    [finding('x', 'a'), finding('x', 'c'), finding('x', 'd'), finding('x', 'b')],
    impactByRule,
  );
  assert.deepEqual(
    filterMinImpact(findings, 'high').map(({ ruleId }) => ruleId),
    ['d', 'b'],
  );
  assert.equal(filterMinImpact(findings, undefined), findings);
});

test('sorting puts the most severe first within each file and keeps file order and ties', () => {
  const findings = annotateImpact(
    [
      finding('one.ts', 'a'),
      finding('one.ts', 'c'),
      finding('one.ts', 'b'),
      finding('one.ts', 'c'),
      finding('two.ts', 'b'),
      finding('two.ts', 'a'),
    ],
    impactByRule,
  );
  const [, firstMedium, , secondMedium] = findings;
  assert.ok(firstMedium);
  assert.ok(secondMedium);
  firstMedium.marker = 'first medium';
  secondMedium.marker = 'second medium';
  const sorted = sortByImpactWithinFiles(findings);
  assert.deepEqual(
    sorted.map(({ file, ruleId }) => `${file}:${ruleId}`),
    ['one.ts:b', 'one.ts:c', 'one.ts:c', 'one.ts:a', 'two.ts:b', 'two.ts:a'],
  );
  assert.deepEqual(
    sorted.filter(({ marker }) => marker).map(({ marker }) => marker),
    ['first medium', 'second medium'],
  );
});
