import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRuns } from '../../scripts/engine-parity.js';
import type { Finding } from '../../lib/shared/types.js';

const finding = (ruleId: string, line = 1) => ({ file: 'a.ts', line, column: 2, ruleId, message: 'ignored' });
const run = (findings: Finding[], extra = {}) => ({
  exitCode: 0,
  stderrFirstLine: '',
  result: { findings, scannedFiles: 3, ...extra },
});

test('identical runs are the same, whatever the message or order', () => {
  const comparison = compareRuns(run([finding('a'), finding('b')]), run([finding('b'), finding('a')]));
  assert.equal(comparison.kind, 'same');
});

test('findings only the JS engine reports are listed as only-js', () => {
  const comparison = compareRuns(run([finding('a'), finding('b')]), run([finding('a')]));
  assert.equal(comparison.kind, 'different');
  assert.deepEqual(comparison.onlyJs, [{ ruleId: 'b', file: 'a.ts', line: '1', column: '2' }]);
  assert.deepEqual(comparison.onlyNative, []);
});

test('findings only the native engine reports are listed as only-native', () => {
  const comparison = compareRuns(run([finding('a')]), run([finding('a'), finding('a', 9)]));
  assert.equal(comparison.kind, 'different');
  assert.equal(comparison.onlyNative.length, 1);
  assert.equal(comparison.onlyNative[0].line, '9');
});

test('differing scanned or skipped files are a difference', () => {
  const scanned = compareRuns(run([]), run([], { scannedFiles: 4 }));
  assert.equal(scanned.kind, 'different');
  assert.equal(scanned.scannedDiffers, true);
  const skipped = compareRuns(run([]), run([], { skippedFiles: ['x.ts'] }));
  assert.equal(skipped.kind, 'different');
  assert.equal(skipped.skippedDiffers, true);
});

test('an engine exiting 2 makes the project not comparable', () => {
  const failed = { exitCode: 2, stderrFirstLine: 'native binary missing', result: null };
  const comparison = compareRuns(run([]), failed);
  assert.deepEqual(comparison, { kind: 'not-comparable', reason: 'native binary missing' });
});
