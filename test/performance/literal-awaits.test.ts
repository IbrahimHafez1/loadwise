import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lint } from './helpers.js';
import { scanWithFixes, requireOnlyChange } from './site-fix-helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import { fixOf, noteOf } from '../types/finding-fix.js';

const rule = 'serial-awaits-in-literal';
const header = 'declare function a(): Promise<number>;\ndeclare function b(): Promise<number>;\n';

function findings(body: string) {
  return lint(`${header}async function run() { ${body} }`).filter((finding: Finding) => finding.ruleId === rule);
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
  const run = (body: string) =>
    lint(`${header}${client}async function run() { ${body} }`).filter((finding: Finding) => finding.ruleId === rule);
  assert.deepEqual(
    run('return db.transaction(async (manager) => ({ x: await c(manager), y: await d(manager) }));'),
    [],
  );
  assert.equal(run('return db.transaction(async (manager) => ({ x: await c(manager), y: await a() }));').length, 1);
  assert.deepEqual(
    run(
      'return db.transaction(async (manager: any) => ({ x: await manager.read(), y: await manager.repo().count() }));',
    ),
    [],
  );
});

test('array fix wraps the calls in Promise.all', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}export async function run() {\n  const [x, y] = [await a(), await b()];\n  return [x, y];\n}`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  assert.equal(requireOnlyChange(finding).after, 'const [x, y] = await Promise.all([a(), b()]);');
  assert.equal(fixOf(finding).requiresReview, true);
});

test('array fix adds parentheses when the literal is a receiver', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}export async function run() {\n  return [await a(), await b()].map((n) => n + 1);\n}`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  assert.match(requireOnlyChange(finding).after, /\(await Promise\.all\(\[a\(\), b\(\)\]\)\)\.map/);
});

test('object fix hoists a Promise.all above a const or return', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}export async function run() {\n  return { x: await a(), y: await b() };\n}`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  const change = requireOnlyChange(finding);
  assert.match(change.after, /const \[x, y\] = await Promise\.all\(\[a\(\), b\(\)\]\);/);
  assert.match(change.after, /return \{ x, y \};/);
});

test('object fix is withheld when the return is conditional', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}export async function run(ok: boolean) {\n  if (ok) return { x: await a(), y: await b() };\n}`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  assert.ok(finding);
  assert.equal(finding.fix, undefined);
});

function findFor(context: TestContext, body: string) {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': `${header}declare function plain(): number;\ndeclare const shared: number;\nexport async function run(flag: boolean) {\n${body}\n}`,
  });
  return scanned.find((entry) => entry.ruleId === rule);
}

function fixFor(context: TestContext, body: string) {
  const found = findFor(context, body);
  assert.ok(found, 'rule should report');
  return found;
}

test('mixed object keeps plain values in place and hoists only the awaits', (context) => {
  const finding = fixFor(context, '  return { x: await a(), shared, y: await b(), label: `n${shared}` };');
  const { after } = requireOnlyChange(finding);
  assert.match(after, /const \[x, y\] = await Promise\.all\(\[a\(\), b\(\)\]\);/);
  assert.match(after, /return \{ x, shared, y, label: `n\$\{shared\}` \};/);
  assert.match(noteOf(finding), /Promise\.all starts/);
});

test('a call between the awaits is kept in the literal and flagged for review', (context) => {
  const finding = fixFor(context, '  return { x: await a(), mid: plain(), y: await b() };');
  assert.match(requireOnlyChange(finding).after, /mid: plain\(\)/);
  assert.match(noteOf(finding), /mid/);
});

test('an await at the head of a member chain is hoisted too', (context) => {
  const finding = fixFor(context, '  return { x: await a(), y: (await b()).toFixed(), z: await a() };');
  const { after } = requireOnlyChange(finding);
  assert.match(after, /const \[x, yResult, z\] = await Promise\.all\(\[a\(\), b\(\), a\(\)\]\);/);
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
  const { after } = requireOnlyChange(finding);
  assert.match(
    after,
    /=> \{\n\s+const \[x, y\] = await Promise\.all\(\[a\(\), b\(\)\]\);\n\s+return \{ x, tag: shared, y \};\n\s*\};/,
  );
});

test('an object nested in a call argument hoists above the statement', (context) => {
  const finding = fixFor(
    context,
    '  sink(label({ x: await a(), y: await b() }));\n  function label(value: object) { return value; }\n  function sink(value: object) {}',
  );
  assert.match(requireOnlyChange(finding).after, /const \[x, y\] = await Promise\.all/);
});

test('the serial twin of a Promise.all branch is quiet, or gets a deliberate-serial note', (context) => {
  const twin = findFor(context, '  return flag ? [await a(), await b()] : await Promise.all([a(), b()]);');
  assert.equal(twin, undefined);
  const partial = fixFor(context, '  return flag ? [await a(), await b()] : await Promise.all([a()]);');
  assert.match(noteOf(partial), /other branch already uses Promise\.all/);
});

const repositoryHeader =
  'declare const users: { create(name: string): Promise<number>; findMany(): Promise<number[]>; count(): Promise<number> };\n';

function fixIn(context: TestContext, fileName: string, body: string) {
  const { findings: scanned } = scanWithFixes(context, {
    [fileName]: `${repositoryHeader}export async function run() {\n${body}\n}`,
  });
  const finding = scanned.find((entry) => entry.ruleId === rule);
  assert.ok(finding, 'rule should report');
  return finding;
}

test('reads on the same model are still started together', (context) => {
  const finding = fixIn(
    context,
    'src/report.ts',
    '  return { rows: await users.findMany(), total: await users.count() };',
  );
  assert.match(requireOnlyChange(finding).after, /await Promise\.all\(\[users\.findMany\(\), users\.count\(\)\]\)/);
  assert.equal(fixOf(finding).requiresReview, true);
});

test('no fix when a write precedes a read it may affect, or in a test file', (context) => {
  assert.equal(
    fixIn(context, 'src/seed.ts', '  return [await users.create("a"), await users.findMany()];').fix,
    undefined,
  );
  assert.equal(
    fixIn(context, 'src/pair.ts', '  return { a: await users.create("a"), b: await users.create("b") };').fix,
    undefined,
  );
  assert.equal(
    fixIn(context, 'test/report.spec.ts', '  return { rows: await users.findMany(), total: await users.count() };').fix,
    undefined,
  );
  assert.equal(
    fixIn(context, 'src/report.test.ts', '  return [await users.findMany(), await users.count()];').fix,
    undefined,
  );
});

test('an array literal asserted `as const` keeps the literal and hoists the awaits above it', (context) => {
  const finding = fixIn(
    context,
    'src/pair.ts',
    '  const pair = [await users.findMany(), await users.count()] as const;\n  return pair;',
  );
  const { after } = requireOnlyChange(finding);
  assert.equal(
    after,
    'const [findManyResult, countResult] = await Promise.all([users.findMany(), users.count()]);\n' +
      'const pair = [findManyResult, countResult] as const;',
  );
});

test('a concise arrow body keeps the CRLF line breaks and tab indentation of the file', (context) => {
  const source = [
    'declare function a(): Promise<number>;',
    'declare function b(): Promise<number>;',
    'export const build = async () => ({ x: await a(), y: await b() });',
    '',
  ].join('\r\n');
  const { findings: scanned } = scanWithFixes(context, { 'src/build.ts': source });
  const finding = scanned.find((entry) => entry.ruleId === rule);
  assert.ok(finding?.fix);
  const fixed = finding.fix.changes[0].after;
  assert.match(
    fixed,
    /=> \{\n {2}const \[x, y\] = await Promise\.all\(\[a\(\), b\(\)\]\);\n {2}return \{ x, y \};\n\};/,
  );
});
