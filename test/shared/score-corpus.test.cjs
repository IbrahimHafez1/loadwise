'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  countDeltas,
  findRegressions,
  labelStates,
  normalizeFile,
  scoreUnits,
} = require('../../scripts/score-corpus.cjs');

const REPO = 'demo';
const label = (line, verdict, ruleId = 'floating-promise') => ({
  pillar: 'perf',
  ruleId,
  file: 'src/a.ts',
  line,
  verdict,
  note: `line ${line}`,
});
const finding = (line, extra = {}) => ({
  ruleId: 'floating-promise',
  file: `../../loadwise-corpus/${REPO}/src/a.ts`,
  line,
  ...extra,
});
const score = (findings, labels) => scoreUnits([{ repo: REPO, pillar: 'perf', findings }], { [REPO]: labels });

test('normalizeFile makes scan paths repo-relative with forward slashes', () => {
  assert.equal(normalizeFile('../../loadwise-corpus/demo/src/a.ts', 'demo'), 'src/a.ts');
  assert.equal(normalizeFile(['src', 'a.ts'].join(String.fromCharCode(92)), 'demo'), 'src/a.ts');
});

test('scoreUnits counts TP, FP, missed, unlabelled and contextual findings per rule', () => {
  const labels = [label(1, 'tp'), label(2, 'fp'), label(3, 'missed'), label(4, 'tp')];
  const { rules } = score([finding(1), finding(2), finding(9), finding(4, { contextualReason: 'test' })], labels);
  assert.deepEqual(rules['perf/floating-promise'], {
    tp: 1,
    fp: 1,
    missed: 2,
    unlabelled: 1,
    findings: 3,
    contextual: 1,
    precision: 0.5,
    recall: 0.3333,
  });
});

test('a missed label that is now reported counts as a TP', () => {
  const { rules } = score([finding(3)], [label(3, 'missed')]);
  assert.equal(rules['perf/floating-promise'].tp, 1);
  assert.equal(rules['perf/floating-promise'].recall, 1);
});

test('findRegressions flags a vanished TP and a reappeared FP against the baseline state', () => {
  const labels = [label(1, 'tp'), label(2, 'fp'), label(5, 'fp'), label(6, 'tp')];
  const baseline = { rules: {}, labels: labelStates(score([finding(1), finding(5)], labels).labelResults) };
  const current = score([finding(2), finding(5)], labels);
  const regressions = findRegressions(current, baseline, { compareMetrics: false });
  assert.equal(regressions.length, 2);
  assert.match(regressions[0], /labelled TP disappeared: demo perf\/floating-promise src\/a\.ts:1 \[tp\] line 1/);
  assert.match(regressions[1], /labelled FP reappeared: demo perf\/floating-promise src\/a\.ts:2 \[fp\] line 2/);
});

test('findRegressions ignores labels the baseline has not seen', () => {
  const current = score([], [label(1, 'tp')]);
  assert.deepEqual(findRegressions(current, { rules: {}, labels: {} }, { compareMetrics: false }), []);
});

test('findRegressions reports a precision or recall drop below the baseline', () => {
  const labels = [label(1, 'tp'), label(2, 'fp')];
  const baseline = score([finding(1)], labels);
  const current = score([finding(1), finding(2)], labels);
  const regressions = findRegressions(current, baseline, { compareMetrics: true });
  assert.deepEqual(regressions, ['perf/floating-promise precision dropped 1 -> 0.5']);
  assert.deepEqual(findRegressions(baseline, current, { compareMetrics: true }), []);
});

test('countDeltas lists only rules whose default finding count changed', () => {
  const baseline = score([finding(1), finding(2)], []);
  const current = score([finding(1)], []);
  assert.deepEqual(countDeltas(current, baseline), [{ rule: 'perf/floating-promise', before: 2, after: 1, delta: -1 }]);
  assert.deepEqual(countDeltas(baseline, baseline), []);
});
