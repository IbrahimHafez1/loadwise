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

test('literals passed to a Promise combinator are left to promise-combinator-serial-await', () => {
  assert.deepEqual(findings('return Promise.all([await a(), await b()]);'), []);
  assert.deepEqual(findings('return Promise.allSettled([await a(), await b()]);'), []);
});

test('awaits that all run on the same transaction client are quiet', () => {
  const client =
    'declare const db: { transaction<T>(work: (manager: object) => Promise<T>): Promise<T> };\n' +
    'declare function c(manager: object): Promise<number>;\ndeclare function d(manager: object): Promise<number>;\n';
  const run = (body) =>
    lint(`${header}${client}async function run() { ${body} }`).filter((finding) => finding.ruleId === rule);
  assert.deepEqual(
    run('return db.transaction(async (manager) => ({ x: await c(manager), y: await d(manager) }));'),
    [],
  );
  assert.equal(run('return db.transaction(async (manager) => ({ x: await c(manager), y: await a() }));').length, 1);
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

function fixFor(context, body) {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}declare function plain(): number;\ndeclare const shared: number;\nexport async function run(flag: boolean) {\n${body}\n}`,
  });
  return scanned.find((entry) => entry.ruleId === rule);
}

test('mixed object keeps plain values in place and hoists only the awaits', (context) => {
  const finding = fixFor(context, '  return { x: await a(), shared, y: await b(), label: `n${shared}` };');
  const { after } = onlyChange(finding);
  assert.match(after, /const \[xValue, yValue\] = await Promise\.all\(\[a\(\), b\(\)\]\);/);
  assert.match(after, /return \{ x: xValue, shared, y: yValue, label: `n\$\{shared\}` \};/);
  assert.match(finding.fix.note, /Promise\.all starts/);
});

test('a call between the awaits is kept in the literal and flagged for review', (context) => {
  const finding = fixFor(context, '  return { x: await a(), mid: plain(), y: await b() };');
  assert.match(onlyChange(finding).after, /mid: plain\(\)/);
  assert.match(finding.fix.note, /mid/);
});

test('an await at the head of a member chain is hoisted too', (context) => {
  const finding = fixFor(context, '  return { x: await a(), y: (await b()).toFixed(), z: await a() };');
  const { after } = onlyChange(finding);
  assert.match(after, /const \[xValue, yResult, zValue\] = await Promise\.all\(\[a\(\), b\(\), a\(\)\]\);/);
  assert.match(after, /y: yResult\.toFixed\(\)/);
});

test('hoisting is withheld for conditional awaits and for effects before the literal in the statement', (context) => {
  assert.equal(fixFor(context, '  return { x: await a(), z: await b(), y: flag ? await b() : 0 };').fix, undefined);
  assert.equal(fixFor(context, '  return [plain(), { x: await a(), y: await b() }];').fix, undefined);
  assert.equal(fixFor(context, '  return flag && { x: await a(), y: await b() };').fix, undefined);
});

test('a concise arrow body becomes a block that hoists the awaits', (context) => {
  const finding = fixFor(
    context,
    '  const build = async () => ({ x: await a(), tag: shared, y: await b() });\n  return build;',
  );
  const { after } = onlyChange(finding);
  assert.match(
    after,
    /=> \{\n\s+const \[xValue, yValue\] = await Promise\.all\(\[a\(\), b\(\)\]\);\n\s+return \{ x: xValue, tag: shared, y: yValue \};\n\s*\};/,
  );
});

test('an object nested in a call argument hoists above the statement', (context) => {
  const finding = fixFor(
    context,
    '  sink(label({ x: await a(), y: await b() }));\n  function label(value: object) { return value; }\n  function sink(value: object) {}',
  );
  assert.match(onlyChange(finding).after, /const \[xValue, yValue\] = await Promise\.all/);
});

test('the serial twin of a Promise.all branch gets a deliberate-serial note', (context) => {
  const finding = fixFor(context, '  return flag ? [await a(), await b()] : await Promise.all([a(), b()]);');
  assert.match(finding.fix.note, /other branch already uses Promise\.all/);
});
