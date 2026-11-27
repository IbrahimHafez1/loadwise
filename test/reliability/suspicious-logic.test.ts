import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import ts from 'typescript';
import { checkSuspiciousLogic } from '../../lib/reliability/suspicious-logic.js';
import { buildFix, createFileCache, loadBuilders } from '../../lib/performance/site-fix.js';
import type { Finding } from '../../lib/shared/types.js';

await loadBuilders();

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');

function check(source: string, file = 'src/example.js', options: ts.CompilerOptions = {}) {
  return checkSuspiciousLogic(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), file, options);
}

function ruleIds(source: string, file?: string, options?: ts.CompilerOptions): string[] {
  return check(source, file, options).map(({ ruleId }) => ruleId);
}

function fixFixture(context: TestContext, source: string, fileName = 'fixture.js') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-suspicious-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, fileName);
  fs.writeFileSync(file, source);
  const [finding] = check(source, file);
  assert.ok(finding, 'expected a finding');
  return { finding, fix: buildFix(finding, createFileCache(), { comments: false }) };
}

test('assignment-in-condition flags = against a literal, identifier or property', () => {
  const sources = [
    'if (x = 5) { go(); }',
    'if (x = y) { go(); }',
    'if (user.admin = flags.admin) { go(); }',
    'if (x = cache[key]) { go(); }',
    'while (done = false) { go(); }',
    'do { go(); } while (retry = true);',
    'for (; ready = other; ) { go(); }',
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), ['assignment-in-condition'], source);
  const [finding] = check('if (x = 5) { go(); }');
  assert.deepEqual([finding.line, finding.column], [1, 5]);
});

test('assignment-in-condition accepts doubled parentheses, calls, loops over chains and compound assignment', () => {
  const sources = [
    'if ((x = y)) { go(); }',
    'const label = ((x = 1)) ? "a" : "b";',
    'const label = (x = 1) ? "a" : "b";',
    'const label = (x = y) ? "a" : "b";',
    'while (match = pattern.exec(text)) { go(); }',
    'while ((match = pattern.exec(text))) { go(); }',
    'if (value = await load()) { go(); }',
    'if (item = new Item()) { go(); }',
    'while (node = node.parent) { go(); }',
    'while (line = lines[index]) { go(); }',
    'if (x += 1) { go(); }',
    'if (x === 5) { go(); }',
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), [], source);
});

test('assignment-in-condition fix turns = into === and waits for review', (context) => {
  const { fix } = fixFixture(context, 'if (x = 5) {\n  go();\n}\n');
  assert.ok(fix);
  assert.equal(fix.requiresReview, true);
  assert.deepEqual(
    fix.changes.map(({ before, after }) => [before, after]),
    [['if (x = 5) {', 'if (x === 5) {']],
  );
});

test('nan-comparison flags every equality operator, either side and Number.NaN in unchecked JavaScript', () => {
  const sources = [
    'if (x === NaN) {}',
    'if (x == NaN) {}',
    'if (x !== NaN) {}',
    'if (x != NaN) {}',
    'if (NaN === x) {}',
    'if (x === Number.NaN) {}',
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), ['nan-comparison'], source);
  assert.match(check('x === NaN')[0].message, /always false/);
  assert.match(check('x !== NaN')[0].message, /always true/);
});

test('nan-comparison is left to the compiler in TypeScript, checkJs and @ts-check files', () => {
  assert.deepEqual(ruleIds('if (x === NaN) {}', 'src/example.ts'), []);
  assert.deepEqual(ruleIds('if (x === NaN) {}', 'src/example.tsx'), []);
  assert.deepEqual(ruleIds('if (x === NaN) {}', 'src/example.js', { checkJs: true }), []);
  assert.deepEqual(ruleIds('// @ts-check\nif (x === NaN) {}'), []);
  assert.deepEqual(ruleIds('if (Number.isNaN(x)) {}'), []);
  assert.deepEqual(ruleIds('if (x === NaNValue) {}'), []);
});

test('nan-comparison fix uses Number.isNaN and negates for != and !==', (context) => {
  const positive = fixFixture(context, 'if (value === NaN) {\n  go();\n}\n');
  assert.deepEqual(
    positive.fix?.changes.map(({ after }) => after),
    ['if (Number.isNaN(value)) {'],
  );
  assert.equal(positive.fix?.requiresReview, true);
  assert.ok(positive.fix?.note);
  const negated = fixFixture(context, 'const ok = NaN !== total.sum;\n');
  assert.deepEqual(
    negated.fix?.changes.map(({ after }) => after),
    ['const ok = !Number.isNaN(total.sum);'],
  );
});

test('nan-comparison fix is skipped when a comment sits inside the comparison', (context) => {
  const { finding, fix } = fixFixture(context, 'if (value === /* why */ NaN) {\n  go();\n}\n');
  assert.equal(finding.ruleId, 'nan-comparison');
  assert.equal(fix, undefined);
});

test('invalid-typeof-comparison flags misspelled results in unchecked JavaScript', () => {
  const sources = [
    "if (typeof x === 'strnig') {}",
    'if (typeof x == "fucntion") {}',
    "if ('nubmer' !== typeof x) {}",
    "if (typeof x === 'array') {}",
    "if (typeof x === 'String') {}",
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), ['invalid-typeof-comparison'], source);
  assert.deepEqual(check("if (typeof x === 'strnig') {}")[0].column, 18);
});

test('invalid-typeof-comparison accepts valid names, other comparisons, TypeScript and checked JavaScript', () => {
  assert.deepEqual(ruleIds("if (typeof x === 'string' || typeof x === 'function') {}"), []);
  assert.deepEqual(ruleIds("if (typeof x === 'bigint' && typeof y !== 'symbol') {}"), []);
  assert.deepEqual(ruleIds("if (kind === 'strnig') {}"), []);
  assert.deepEqual(ruleIds("if (typeof x === 'strnig') {}", 'src/example.ts'), []);
  assert.deepEqual(ruleIds("if (typeof x === 'strnig') {}", 'src/example.mjs', { checkJs: true }), []);
  assert.deepEqual(ruleIds("// @ts-check\nif (typeof x === 'strnig') {}", 'src/example.cjs'), []);
});

test('invalid-typeof-comparison fix corrects only an unambiguous typo and keeps the quotes', (context) => {
  const typo = fixFixture(context, 'if (typeof value === "strnig") {\n  go();\n}\n');
  assert.deepEqual(
    typo.fix?.changes.map(({ after }) => after),
    ['if (typeof value === "string") {'],
  );
  assert.equal(typo.fix?.requiresReview, true);
  const wrongCase = fixFixture(context, "if (typeof value === 'String') {\n  go();\n}\n");
  assert.deepEqual(
    wrongCase.fix?.changes.map(({ after }) => after),
    ["if (typeof value === 'string') {"],
  );
  const unknown = fixFixture(context, "if (typeof value === 'array') {\n  go();\n}\n");
  assert.equal(unknown.fix, undefined);
});

test('unreachable-code reports the first dead statement once per block', () => {
  const findings = check(
    'function run() {\n  return 1;\n  first();\n  second();\n}\nfunction other(list) {\n  for (const item of list) {\n    if (item) continue;\n    skipped();\n  }\n  throw new Error("x");\n  after();\n}',
  );
  assert.deepEqual(
    findings.map(({ ruleId, line, column }) => [ruleId, line, column]),
    [
      ['unreachable-code', 3, 3],
      ['unreachable-code', 12, 3],
    ],
  );
  assert.match(findings[0].message, /return/);
  assert.match(findings[1].message, /throw/);
  assert.deepEqual(
    ruleIds('switch (x) {\n  case 1:\n    return a;\n    log();\n  case 2:\n    break;\n    log();\n}'),
    ['unreachable-code', 'unreachable-code'],
  );
  assert.deepEqual(ruleIds('while (true) {\n  break;\n  cleanup();\n}'), ['unreachable-code']);
});

test('unreachable-code accepts hoisted functions, type declarations, bare var, empty statements and case breaks', () => {
  const sources = [
    'function run() { return helper(); function helper() {} }',
    'function run() { return 1; var later; }',
    'function run() { return 1; ; }',
    'function run() { return 1; var a, b; function c() {} }',
    'switch (x) { case 1: return a; break; default: throw b; }',
    'function run() { if (a) { return 1; } next(); }',
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), [], source);
  assert.deepEqual(ruleIds('function run() { return 1; interface Shape {} type Id = string; }', 'src/example.ts'), []);
  assert.deepEqual(ruleIds('function run() { return 1; var seeded = 1; }'), ['unreachable-code']);
  assert.deepEqual(ruleIds('function run() { return 1; let later; }'), ['unreachable-code']);
});

test('unreachable-code is skipped when the compiler already errors on it', () => {
  const source = 'function run() {\n  return 1;\n  dead();\n}';
  assert.deepEqual(ruleIds(source, 'src/example.ts', { allowUnreachableCode: false }), []);
  assert.deepEqual(ruleIds(source, 'src/example.ts', { allowUnreachableCode: true }), ['unreachable-code']);
  assert.deepEqual(ruleIds(source, 'src/example.ts'), ['unreachable-code']);
});

test('unreachable-code fix deletes the dead statements but keeps hoisted functions, and waits for review', (context) => {
  const source = 'function run() {\n  return 1;\n  first();\n  function kept() {}\n  second();\n}\n';
  const { fix } = fixFixture(context, source);
  assert.ok(fix);
  assert.equal(fix.requiresReview, true);
  assert.deepEqual(
    fix.changes.map(({ before, after }) => [before, after]),
    [['  first();\n  function kept() {}\n  second();', '  function kept() {}\n']],
  );
});

test('unreachable-code fix is refused when the dead code declares a var that earlier code may read', (context) => {
  const sources = [
    'function run() {\n  use(seeded);\n  return 1;\n  var seeded = 2;\n}\n',
    'function run() {\n  return 1;\n  for (var index = 0; index < 3; index++) { use(index); }\n}\n',
  ];
  for (const source of sources) {
    const { finding, fix } = fixFixture(context, source);
    assert.equal(finding.ruleId, 'unreachable-code');
    assert.equal(fix, undefined, source);
  }
});

test('loop-index-past-length flags <= length when the body reads the same receiver at the index', () => {
  const sources = [
    'for (let i = 0; i <= items.length; i++) { use(items[i]); }',
    'for (let i = 0; i <= this.rows.length; i++) { use(this.rows[i].id); }',
    'for (var i = 0; i <= list.length; ++i) { total += list[i]; }',
    'for (let i = 0; i <= items.length; i += 1) { if (items[i].ok) go(); }',
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), ['loop-index-past-length'], source);
  assert.deepEqual(check('for (let i = 0; i <= items.length; i++) { use(items[i]); }')[0].column, 17);
});

test('loop-index-past-length accepts < length, other receivers, writes, reassignment, guards and while loops', () => {
  const sources = [
    'for (let i = 0; i < items.length; i++) { use(items[i]); }',
    'for (let i = 0; i <= items.length; i++) { use(other[i]); }',
    'for (let i = 0; i <= items.length; i++) { use(items[i - 1]); }',
    'for (let i = 0; i <= items.length; i++) { items[i] = 0; }',
    'for (let i = 0; i <= items.length; i++) { use(items[i]); i++; }',
    'for (let i = 0; i <= items.length; i++) { if (i < items.length) use(items[i]); }',
    'for (let i = 0; i <= load().length; i++) { use(load()[i]); }',
    'for (let i = 0; i <= items.length; i++) { use(i); }',
    'for (let i = 0; i <= items.length; i += 2) { use(items[i]); }',
    'for (let i = 1; i <= items.length; i++) { use(items[i]); }',
    'for (let i = start; i <= items.length; i++) { use(items[i]); }',
    'let i = 0; while (i <= items.length) { use(items[i]); i++; }',
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), [], source);
});

test('loop-index-past-length accepts a sentinel pass that tests the read value for undefined', () => {
  const sources = [
    'for (let i = 0; i <= tokens.length; i++) { const t = tokens[i]; if (!t) { flush(); break; } use(t); }',
    'for (let i = 0; i <= tokens.length; i++) { const t = tokens[i]; if (t === undefined) { flush(); } }',
    'for (let i = 0; i <= tokens.length; i++) { const t = tokens[i]; if (t == null) { flush(); } }',
    'for (let i = 0; i <= tokens.length; i++) { if (tokens[i] === undefined) { flush(); } }',
    'for (let i = 0; i <= tokens.length; i++) { const t = tokens[i]; if (typeof t === "undefined") flush(); }',
    'for (let i = 0; i <= tokens.length; i++) { const t = tokens[i]; use(t?.value); }',
    'for (let i = 0; i <= tokens.length; i++) { if (i === tokens.length) { flush(); } else { use(tokens[i]); } }',
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), [], source);
});

test('loop-index-past-length fix changes <= to <', (context) => {
  const { fix } = fixFixture(context, 'for (let i = 0; i <= items.length; i++) {\n  use(items[i]);\n}\n');
  assert.ok(fix);
  assert.equal(fix.requiresReview, true);
  assert.deepEqual(
    fix.changes.map(({ after }) => after),
    ['for (let i = 0; i < items.length; i++) {'],
  );
});

test('test files, vendored folders and generated sources are skipped', () => {
  const source = 'if (x = 5) { go(); }';
  assert.deepEqual(ruleIds(source, 'src/example.test.js'), []);
  assert.deepEqual(ruleIds(source, 'test/helpers.js'), []);
  assert.deepEqual(ruleIds(source, 'public/vendor/lib.js'), []);
  assert.deepEqual(ruleIds(`/* eslint-disable */\n// @generated\n${source}`, 'src/types.js'), []);
  assert.deepEqual(ruleIds(source, 'src/example.js'), ['assignment-in-condition']);
});

test('rel --json reports a JavaScript finding with a fix', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-suspicious-cli-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'check.js');
  fs.writeFileSync(file, 'export function isMissing(value) {\n  return value === NaN;\n}\n');
  const run = spawnSync(process.execPath, [bin, 'rel', file, '--json'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(run.status, 1, run.stderr);
  const report: { findings: Finding[] } = JSON.parse(run.stdout);
  const finding = report.findings.find(({ ruleId }) => ruleId === 'nan-comparison');
  assert.ok(finding, run.stdout);
  assert.equal(finding.line, 2);
  assert.deepEqual(
    finding.fix?.changes.map(({ after }) => after.split('\n').at(-1)),
    ['  return Number.isNaN(value);'],
  );
});

test('unreachable-code skips fixture sources', () => {
  const source = 'function f() {\n  return 1;\n  cleanup();\n}';
  assert.deepEqual(ruleIds(source, 'test/__fixtures__/sample.js'), []);
  assert.deepEqual(ruleIds(source, 'src/fixtures/sample.js'), []);
  assert.deepEqual(ruleIds(source, 'src/real.js'), ['unreachable-code']);
});
