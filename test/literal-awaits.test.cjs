const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const rule = 'serial-awaits-in-literal';
const header = 'declare function a(): Promise<number>;\ndeclare function b(): Promise<number>;\n';

function findings(body) {
  return lint(`${header}async function run() { ${body} }`).filter((finding) => finding.ruleId === rule);
}

test('array and object literals with two awaits are reported once', () => {
  assert.equal(findings('return [await a(), await b()];').length, 1);
  assert.equal(findings('return [await a(), await b(), await a()];').length, 1);
  assert.equal(findings('return { x: await a(), y: await b() };').length, 1);
});

test('single await, no awaits, and writes inside the literal are quiet', () => {
  assert.deepEqual(findings('return [await a(), b()];'), []);
  assert.deepEqual(findings('return [await a(), 1];'), []);
  assert.deepEqual(findings('let n = 0; return [await a(), (n = 1), await b()];'), []);
  assert.deepEqual(findings('return [(await a()) + 1, (await b()) + 1];'), []);
});

test('array fix wraps the calls in Promise.all', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}export async function run() {\n  const [x, y] = [await a(), await b()];\n  return [x, y];\n}`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  assert.equal(onlyChange(finding).after, 'const [x, y] = await Promise.all([a(), b()]);');
});

test('array fix adds parentheses when the literal is a receiver', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}export async function run() {\n  return [await a(), await b()].map((n) => n + 1);\n}`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  assert.match(onlyChange(finding).after, /\(await Promise\.all\(\[a\(\), b\(\)\]\)\)\.map/);
});

test('object fix hoists a Promise.all above a const or return', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}export async function run() {\n  return { x: await a(), y: await b() };\n}`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  const change = onlyChange(finding);
  assert.match(change.after, /const \[xValue, yValue\] = await Promise\.all\(\[a\(\), b\(\)\]\);/);
  assert.match(change.after, /return \{ x: xValue, y: yValue \};/);
});

test('object fix is withheld when the return is conditional', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}export async function run(ok: boolean) {\n  if (ok) return { x: await a(), y: await b() };\n}`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  assert.ok(finding);
  assert.equal(finding.fix, undefined);
});
