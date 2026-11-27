import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import ts from 'typescript';
import { checkUnusedBindings } from '../../lib/maintainability/unused-bindings.js';
import { buildFix } from '../../lib/maintainability/site-fix.js';
import { applyFix } from '../../lib/maintainability/apply-fix.js';
import type { Finding } from '../../lib/shared/types.js';

const cli = path.join(import.meta.dirname, '../../bin/loadwise.js');

function scan(text: string, file = 'sample.ts', options: ts.CompilerOptions = {}) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return { sourceFile, findings: checkUnusedBindings(sourceFile, file, options) };
}

function names(text: string, file?: string, options?: ts.CompilerOptions): string[] {
  return scan(text, file, options).findings.map((finding) => finding.ruleId + ':' + finding.message.split("'")[1]);
}

function fixed(text: string, ruleId: string, file = 'sample.ts') {
  const { sourceFile, findings } = scan(text, file);
  const entry = {
    text,
    sourceFile,
    absolute: file,
    filename: file,
    lineStarts: [...sourceFile.getLineStarts()],
    scriptKind: sourceFile.scriptKind,
  };
  const fixes = findings
    .filter((finding: Finding) => finding.ruleId === ruleId)
    .map((finding) => buildFix(finding, () => entry, { comments: false }));
  return fixes.map((fix) => {
    if (!fix) return undefined;
    let after = text;
    applyFix(fix, { readFile: () => text, writeFile: (_file, value) => (after = value) });
    return { after, requiresReview: Boolean(fix.requiresReview) };
  });
}

test('reports each unused default, named and namespace import once', () => {
  const text = "import a, { b, c as d } from 'x';\nimport * as ns from 'y';\nimport type { T } from 'z';\n";
  assert.deepEqual(names(text), [
    'unused-import:a',
    'unused-import:b',
    'unused-import:d',
    'unused-import:ns',
    'unused-import:T',
  ]);
});

test('references of every kind count as uses', () => {
  const text = [
    "import { a, b, c, d, e, f } from 'x';",
    'type Alias = typeof a;',
    'export { b };',
    '@c() class K { m(): d { return 1; } }',
    'const el = <e.Tag />;',
    'f(1);',
    'export { Alias, K, el };',
  ].join('\n');
  assert.deepEqual(names(text, 'sample.tsx'), []);
});

test('keeps side-effect imports, declaration files and noUnusedLocals projects', () => {
  assert.deepEqual(names("import './polyfill';\n"), []);
  assert.deepEqual(names("import { a } from 'x';\n", 'types.d.ts'), []);
  assert.deepEqual(
    names("import { a } from 'x';\nconst b = 1;\nexport function f() { const c = 2; }\n", 'sample.ts', {
      noUnusedLocals: true,
    }),
    [],
  );
});

test('the classic JSX factory import is used by JSX, an automatic runtime import is not', () => {
  const text = "import React from 'react';\nexport const el = <div />;\n";
  assert.deepEqual(names(text, 'view.tsx', { jsx: ts.JsxEmit.React }), []);
  assert.deepEqual(names(text, 'view.tsx', {}), []);
  assert.deepEqual(names(text, 'view.tsx', { jsx: ts.JsxEmit.ReactJSX }), ['unused-import:React']);
  assert.deepEqual(names("import React from 'react';\nexport const n = 1;\n", 'view.tsx', { jsx: ts.JsxEmit.React }), [
    'unused-import:React',
  ]);
});

test('a name used only in JSDoc is kept', () => {
  assert.deepEqual(names("import { Foo } from 'x';\n/** @type {Foo} */\nexport const v = null;\n", 'a.js'), []);
});

test('reports unused locals but not underscore, rest siblings, loop variables or catch bindings', () => {
  const text = [
    'export function run(items: number[]) {',
    '  const unused = 1;',
    '  const _ignored = 2;',
    '  const { omitted, ...rest } = { omitted: 1, other: 2 };',
    '  for (const item of items) {}',
    '  try { rest.other; } catch (error) {}',
    '  let assigned = 0;',
    '  assigned = 1;',
    '  return rest;',
    '}',
  ].join('\n');
  assert.deepEqual(names(text), ['unused-local-variable:unused']);
});

test('honours eslint-disable comments for unused variables', () => {
  const body = "import { a } from './a.js';\nconst b = 1;\n";
  for (const directive of [
    '/* eslint-disable */',
    '/* eslint-disable no-unused-vars */',
    '/* eslint-disable @typescript-eslint/no-unused-vars, no-console */',
  ]) {
    assert.deepEqual(names(`${directive}\n${body}export {};\n`), [], directive);
  }
  assert.deepEqual(names(`/* eslint-disable no-console */\n${body}`), ['unused-import:a', 'unused-local-variable:b']);
  const nextLine =
    "// eslint-disable-next-line @typescript-eslint/no-unused-vars\nimport { a } from './a.js';\nconst b = 1;\n";
  assert.deepEqual(names(nextLine), ['unused-local-variable:b']);
  assert.deepEqual(names('const b = 1; // eslint-disable-line no-unused-vars\nexport {};\n'), []);
});

test('skips fixtures, vendored files and documentation samples', () => {
  const text = "import { a } from './a.js';\nconst b = 1;\n";
  for (const file of [
    'src/rule.input.ts',
    'src/rule.output.ts',
    'test/__fixtures__/a.ts',
    'test/fixtures/a.ts',
    'test/__testfixtures__/a.ts',
    'vendor/a.ts',
    'public/assets/a.js',
    'docs/sample.ts',
    'examples/a.ts',
  ]) {
    assert.deepEqual(names(text, file), [], file);
  }
  assert.equal(names(text, 'src/real.ts').length, 2);
});

test('module-level private constants count, script globals and exports do not', () => {
  assert.deepEqual(names('const hidden = 1;\nexport const shown = 2;\n'), ['unused-local-variable:hidden']);
  assert.deepEqual(names('const global = 1;\n'), []);
});

test('a file with eval keeps its locals', () => {
  assert.deepEqual(names("export function f() { const x = 1; return eval('x'); }\n"), []);
});

test('removes one unused name and keeps the rest of the import', () => {
  const text = "import { a, b, c } from 'x';\nexport { a, c };\n";
  const [result] = fixed(text, 'unused-import');
  assert.equal(result?.after, "import { a, c } from 'x';\nexport { a, c };\n");
  const [defaultResult] = fixed("import d, { b } from 'x';\nexport { b };\n", 'unused-import');
  assert.equal(defaultResult?.after, "import { b } from 'x';\nexport { b };\n");
  const [namedResult] = fixed("import d, { b } from 'x';\nexport { d };\n", 'unused-import');
  assert.equal(namedResult?.after, "import d from 'x';\nexport { d };\n");
});

test('removing a whole import needs review unless it only held types', () => {
  const [value] = fixed("import { a } from 'x';\nexport const n = 1;\n", 'unused-import');
  assert.deepEqual(value, { after: 'export const n = 1;\n', requiresReview: true });
  const [typeOnly] = fixed("import type { T } from 'x';\nexport const n = 1;\n", 'unused-import');
  assert.deepEqual(typeOnly, { after: 'export const n = 1;\n', requiresReview: false });
});

test('a local mentioned only in JSDoc is kept', () => {
  assert.deepEqual(names('/** See {@link helper} and @see other. */\nexport const x = 1;\nconst helper = 1;\n'), []);
  assert.deepEqual(names('const gone = 1;\nexport const x = 1;\n'), ['unused-local-variable:gone']);
});

test('removing the only import line at the very end of the file stays inside the text', () => {
  const [result] = fixed("import { a } from 'x';\n", 'unused-import');
  assert.equal(result?.after, '\n');
});

// `loadwise fix` stages every finding of a file together, so identical edits from findings of one
// import must collapse into one change and different ones must not overlap.
function fixEveryUnusedImport(context: TestContext, source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-bindings-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(root, 'src'));
  const file = path.join(root, 'src', 'm.ts');
  fs.writeFileSync(file, source);
  const args = [cli, 'fix', '--all', 'maint', '--rule', 'unused-import', '--no-comments', '--no-verify-types'];
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  return fs.readFileSync(file, 'utf8');
}

test('every unused name of one import is removed in one run, wherever it sits', (context) => {
  assert.equal(
    fixEveryUnusedImport(context, "import { c, a, b } from 'x';\nexport const v = c;\n"),
    "import { c } from 'x';\nexport const v = c;\n",
  );
  assert.equal(
    fixEveryUnusedImport(context, "import { a, c, b } from 'x';\nexport const v = c;\n"),
    "import { c } from 'x';\nexport const v = c;\n",
  );
});

test('a used default with only unused named imports keeps just the default', (context) => {
  assert.equal(
    fixEveryUnusedImport(context, "import d, { a, b } from 'x';\nexport const v = d;\n"),
    "import d from 'x';\nexport const v = d;\n",
  );
});

test('an import with every name unused is removed once', (context) => {
  assert.equal(
    fixEveryUnusedImport(context, "import d, { a, b } from 'x';\nexport const v = 1;\n"),
    'export const v = 1;\n',
  );
});

test('an unused import alone on line 1 is removed with a following import kept', (context) => {
  assert.equal(
    fixEveryUnusedImport(context, "import { a } from 'x';\nimport { c } from 'y';\nexport const v = c;\n"),
    "import { c } from 'y';\nexport const v = c;\n",
  );
});

test('an import clause holding comments is not rewritten', () => {
  const [commented] = fixed("import { a, /* keep */ b } from 'x';\nexport { b };\n", 'unused-import');
  assert.equal(commented, undefined);
  const [lineComment] = fixed("import {\n  a, // why\n  b,\n} from 'x';\nexport { b };\n", 'unused-import');
  assert.equal(lineComment, undefined);
});

// Two ids of one import carry the same rewrite; the second must read as done, not as stale.
test('--fix --only with two ids of one import applies once and reports the second as applied', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-bindings-only-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(root, 'src'));
  const file = path.join(root, 'src', 'm.ts');
  fs.writeFileSync(file, "import { a, b, c } from 'x';\nexport const v = c;\n");
  const scanRun = spawnSync(process.execPath, [cli, 'maint', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  const ids: string[] = JSON.parse(scanRun.stdout.slice(scanRun.stdout.indexOf('{')))
    .findings.filter((finding: Finding) => finding.ruleId === 'unused-import')
    .map((finding: Finding) => finding.id);
  assert.equal(ids.length, 2, scanRun.stderr + scanRun.stdout);
  const run = spawnSync(process.execPath, [cli, 'maint', '--fix', '--only', ids.join(','), '--no-comments'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.doesNotMatch(run.stdout, /changed since the scan/);
  assert.equal(fs.readFileSync(file, 'utf8'), "import { c } from 'x';\nexport const v = c;\n");
});

test('deletes an unused local only when its initializer cannot have effects', () => {
  const text = [
    'export function run() {',
    '  const literal = 1;',
    '  const later = () => 1;',
    '  const called = compute();',
    '  const pair = 1, other = 2;',
    '  return 0;',
    '}',
  ].join('\n');
  const results = fixed(text, 'unused-local-variable');
  assert.equal(results.length, 5);
  assert.ok(results[0]?.after.includes('  const later') && !results[0].after.includes('literal'));
  assert.ok(!results[1]?.after.includes('later'));
  assert.equal(results[2], undefined);
  assert.equal(results[3], undefined);
  assert.equal(results[4], undefined);
});

test('a file with eval keeps its imports', () => {
  assert.deepEqual(names("import { q } from './q.js';\nexport function f() { return eval('q'); }\n"), []);
});

test('removing a whole import that shares its line with a comment or statement is refused', () => {
  const trailingComment = "import { q } from './q.js'; // keep\nexport const a = 1;\n";
  const sameLine = "import Bar from './bar.js'; /* c */ import Baz from './baz.js';\nexport const b = Baz;\n";
  for (const [source, ruleId] of [
    [trailingComment, 'unused-import'],
    [sameLine, 'unused-import'],
  ]) {
    const [result] = fixed(source, ruleId);
    assert.ok(result === undefined || result.after === source, source);
  }
});

test('a local declaration sharing its line with another statement is not removed', () => {
  const [result] = fixed('export function f() { const x = 1; return 2; }\n', 'unused-local-variable');
  assert.ok(result === undefined || result.after === 'export function f() { const x = 1; return 2; }\n');
});
