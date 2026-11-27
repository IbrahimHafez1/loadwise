import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MINIMUM_LABELS_FOR_FLOOR,
  PRECISION_FLOOR,
  classifyStatus,
  countDeltas,
  findBelowFloor,
  findBelowMinPrecision,
  findRegressions,
  labelStates,
  main,
  normalizeFile,
  overallPrecision,
  parseArgs,
  parseMinPrecision,
  scoreUnits,
} from '../../scripts/score-corpus.js';

type ScanUnit = Parameters<typeof scoreUnits>[0][number];
type ScoredFinding = ScanUnit['findings'][number];
type Label = Parameters<typeof scoreUnits>[1][string][number];
type RuleStats = ReturnType<typeof scoreUnits>['rules'][string];

const REPO = 'demo';
const label = (line: number, verdict: string, ruleId = 'floating-promise'): Label => ({
  pillar: 'perf',
  ruleId,
  file: 'src/a.ts',
  line,
  verdict,
  note: `line ${line}`,
});
const finding = (line: number, extra: Partial<ScoredFinding> = {}): ScoredFinding => ({
  ruleId: 'floating-promise',
  file: `../../loadwise-corpus/${REPO}/src/a.ts`,
  line,
  ...extra,
});
const score = (findings: ScoredFinding[], labels: Label[]) =>
  scoreUnits([{ repo: REPO, pillar: 'perf', findings }], { [REPO]: labels });

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
  assert.equal(rules['perf/floating-promise']?.tp, 1);
  assert.equal(rules['perf/floating-promise']?.recall, 1);
});

test('findRegressions flags a vanished TP and a reappeared FP against the baseline state', () => {
  const labels = [label(1, 'tp'), label(2, 'fp'), label(5, 'fp'), label(6, 'tp')];
  const baseline = { rules: {}, labels: labelStates(score([finding(1), finding(5)], labels).labelResults) };
  const current = score([finding(2), finding(5)], labels);
  const regressions = findRegressions(current, baseline, { compareMetrics: false });
  assert.equal(regressions.length, 2);
  assert.match(regressions[0] ?? '', /labelled TP disappeared: demo perf\/floating-promise src\/a\.ts:1 \[tp\] line 1/);
  assert.match(regressions[1] ?? '', /labelled FP reappeared: demo perf\/floating-promise src\/a\.ts:2 \[fp\] line 2/);
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

test('classifyStatus separates unmeasured, thin and measured rules by label count', () => {
  assert.equal(classifyStatus(0), 'unmeasured');
  assert.equal(classifyStatus(1), 'thin');
  assert.equal(classifyStatus(9), 'thin');
  assert.equal(classifyStatus(10), 'measured');
});

const floorStats = (tp: number, fp: number): RuleStats => ({
  tp,
  fp,
  missed: 0,
  unlabelled: 0,
  findings: tp + fp,
  contextual: 0,
  precision: tp / (tp + fp),
  recall: null,
});
const underFloorFp = Math.ceil(MINIMUM_LABELS_FOR_FLOOR * (1 - PRECISION_FLOOR)) + 1;

test('findBelowFloor fails a rule with enough labels and precision under the floor', () => {
  const rules = { 'perf/floating-promise': floorStats(MINIMUM_LABELS_FOR_FLOOR - underFloorFp, underFloorFp) };
  assert.deepEqual(findBelowFloor(rules, []), ['perf/floating-promise']);
});

test('findBelowFloor ignores rules with too few labels or precision at the floor', () => {
  const fewLabels = floorStats(0, MINIMUM_LABELS_FOR_FLOOR - 1);
  const atFloor = floorStats(
    MINIMUM_LABELS_FOR_FLOOR * PRECISION_FLOOR,
    MINIMUM_LABELS_FOR_FLOOR * (1 - PRECISION_FLOOR),
  );
  assert.deepEqual(findBelowFloor({ 'perf/a': fewLabels, 'perf/b': atFloor }, []), []);
});

test('findBelowFloor honours the exceptions list', () => {
  const rules = { 'perf/floating-promise': floorStats(0, MINIMUM_LABELS_FOR_FLOOR) };
  const exceptions = [{ rule: 'perf/floating-promise', reason: 'known' }];
  assert.deepEqual(findBelowFloor(rules, exceptions), []);
});

test('parseArgs and parseMinPrecision validate --min-precision in [0, 1]', async () => {
  assert.equal(parseMinPrecision(undefined), undefined);
  assert.equal(parseMinPrecision('0'), 0);
  assert.equal(parseMinPrecision('1'), 1);
  assert.equal(parseMinPrecision('0.85'), 0.85);
  assert.equal(parseArgs(['--min-precision', '0.9'])['min-precision'], '0.9');

  for (const invalid of ['', 'abc', '-0.1', '1.1', 'NaN', 'Infinity', true]) {
    assert.throws(() => parseMinPrecision(invalid), /--min-precision must be a finite number in \[0, 1\]/);
  }
  assert.equal(await main(['--min-precision', '1.5']), 1);
});

test('findBelowMinPrecision flags rules and overall precision below the threshold', () => {
  const rules = {
    'perf/a': floorStats(9, 1),
    'perf/b': floorStats(3, 1),
    'perf/unmeasured': {
      tp: 0,
      fp: 0,
      missed: 2,
      unlabelled: 0,
      findings: 0,
      contextual: 0,
      precision: null,
      recall: 0,
    },
  };
  assert.equal(overallPrecision(rules), 0.8571);
  assert.deepEqual(findBelowMinPrecision(rules, 0.75), []);
  assert.deepEqual(findBelowMinPrecision(rules, 0.8), ['perf/b']);
  assert.deepEqual(findBelowMinPrecision(rules, 0.88), ['perf/b', 'overall']);
});
