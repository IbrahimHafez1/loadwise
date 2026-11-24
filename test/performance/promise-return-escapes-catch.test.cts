import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import { scanWithFixes } from './site-fix-helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import { fixOf } from '../types/finding-fix.cjs';
import type * as Typescript from 'typescript';

const ruleId = 'promise-return-escapes-catch';
const declarations = `declare function loadValue(): Promise<string>;
declare const pendingValue: PromiseLike<string>;
declare function recoverFailure(): string;
declare function releaseResource(): void;
`;

function reported(source: string) {
  return lint(declarations + source).filter((finding: Finding) => finding.ruleId === ruleId);
}

test('reviewed return await catches the rejection and withholds edits across cleanup boundaries', async (context) => {
  const source = `async function respond(load: () => Promise<string>) {
    try {
      return load();
    } catch {
      return "handled";
    }
  }`;
  const cleanup = `async function cleanup(load: () => Promise<string>, release: () => void) {
    try { return load(); } catch { return "handled"; } finally { release(); }
  }`;
  const findings = scanWithFixes(context, { 'src.ts': source + '\n' + cleanup }).findings.filter(
    (finding) => finding.ruleId === ruleId,
  );
  assert.equal(findings.length, 2);
  assert.equal(fixOf(findings[0]).requiresReview, true);
  assert.equal(findings[1].fix, undefined);
  const [change] = fixOf(findings[0]).changes;
  const fixed = source.replace(change.before, () => change.after);
  const typescript: typeof Typescript = require('typescript');
  const load = (text: string) => new Function(typescript.transpile(text) + '\nreturn respond;')();
  const failure = () => Promise.reject(new Error('unavailable'));
  await assert.rejects(load(source)(failure), /unavailable/);
  assert.equal(await load(fixed)(failure), 'handled');
  assert.equal(await load(fixed)(() => Promise.resolve('ok')), 'ok');
  assert.deepEqual(reported(fixed), []);
});

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
