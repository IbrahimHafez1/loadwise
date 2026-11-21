'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const ruleId = 'return-in-finally';

function reported(source) {
  return lint(source).filter((finding) => finding.ruleId === ruleId);
}

test('returns from finally can replace a pending result or hide a failure', () => {
  const findings = reported(`function completed() {
  try { return 1; } finally { return 2; }
}
async function suppressed(shouldSuppress: boolean) {
  try { throw new Error('failure'); } finally {
    if (shouldSuppress) return;
  }
}
function nestedTry() {
  try { return 1; } finally {
    try { return 2; } catch { throw new Error('cleanup failure'); }
  }
}`);
  assert.deepEqual(
    findings.map(({ line }) => line),
    [2, 6, 11],
  );
  assert.match(findings[0].message, /finally.*replace.*pending.*suppress.*error/i);
  assert.equal(findings[0].suggestion, undefined);
});

test('only a finally block in the same callable can intercept the return', () => {
  const findings = reported(`declare function cleanup(callback?: () => number): void;
function work() {
  try { return 1; } catch { return 2; } finally {
    cleanup(() => { return 3; });
    function local() { return 4; }
    const handlers = { clean() { return 5; } };
    function unsafe() {
      try { return 6; } finally { return 7; }
    }
  }
}
function afterCleanup() {
  try { cleanup(); } finally { cleanup(); }
  return 8;
}`);
  assert.deepEqual(
    findings.map(({ line }) => line),
    [8],
  );
});
