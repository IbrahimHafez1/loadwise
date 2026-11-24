import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import { scanWithFixes, requireFix } from './site-fix-helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const ruleId = 'return-in-finally';

function reported(source: string) {
  return lint(source).filter((finding: Finding) => finding.ruleId === ruleId);
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

test('only a bare return that ends the finally block and the function is removed, for review', (context) => {
  const source = `declare function flush(): void;
export function closing() {
  try { flush(); } finally {
    flush();
    return;
  }
}
export function conditional(flag: boolean) {
  try { flush(); } finally {
    if (flag) return;
  }
}
export function valued() {
  try { return 1; } finally { return 2; }
}
export function followed() {
  try { flush(); } finally { return; }
  flush();
}
`;
  const findings = scanWithFixes(context, { 'src.ts': source }).findings.filter((finding) => finding.ruleId === ruleId);
  assert.deepEqual(
    findings.map(({ line, fix }) => [line, Boolean(fix)]),
    [
      [5, true],
      [10, false],
      [14, false],
      [17, false],
    ],
  );
  assert.equal(requireFix(findings[0]).requiresReview, true);
  assert.deepEqual(
    requireFix(findings[0]).changes.map(({ before, after }) => [before.trim(), after.trim()]),
    [['flush();\n    return;', 'flush();']],
  );
});
