'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const ruleId = 'promise-return-escapes-catch';
const declarations = `declare function loadValue(): Promise<string>;
declare const pendingValue: PromiseLike<string>;
declare function recoverFailure(): string;
declare function releaseResource(): void;
`;

function reported(source) {
  return lint(declarations + source).filter((finding) => finding.ruleId === ruleId);
}

test('returns of standard promises and PromiseLike values can bypass a local catch', () => {
  const findings = reported(`async function load() {
  try {
    return loadValue();
  } catch {
    return recoverFailure();
  }
}
const loadWithCleanup = async () => {
  try {
    try {
      return (pendingValue);
    } finally {
      releaseResource();
    }
  } catch {
    return recoverFailure();
  }
};`);
  assert.deepEqual(
    findings.map(({ line }) => line),
    [7, 15],
  );
  assert.match(findings[0].message, /rejection.+bypass.+catch.*return await/i);
  assert.equal(findings[0].suggestion, undefined);
});

test('awaited returns, nonstandard thenables, generators, and returns outside the guarded try stay quiet', () => {
  assert.deepEqual(
    reported(`declare const unrelated: { then(callback: () => void): void };
declare function unknownValue(): any;
async function awaited() {
  try { return (await loadValue()); } catch { return recoverFailure(); }
}
async function syncValue() {
  try { return unrelated; } catch { return recoverFailure(); }
}
async function untyped() {
  try { return unknownValue(); } catch { return recoverFailure(); }
}
async function cleanupOnly() {
  try { return loadValue(); } finally { releaseResource(); }
}
async function catchArm() {
  try { await loadValue(); } catch { return loadValue(); }
}
async function finallyArm() {
  try { await loadValue(); } catch { recoverFailure(); } finally { return loadValue(); }
}
async function nested() {
  try { const callback = async () => { return loadValue(); }; return callback; }
  catch { return recoverFailure(); }
}
async function* generator() {
  try { return loadValue(); } catch { return recoverFailure(); }
}
function synchronous() {
  try { return loadValue(); } catch { return recoverFailure(); }
}
async function noValue() {
  try { return; } catch { return recoverFailure(); }
}`),
    [],
  );
});
