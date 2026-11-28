import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { checkTypeSafetyHygiene } from '../../lib/maintainability/type-safety-hygiene.js';
import { checkTsconfigStrictness } from '../../lib/maintainability/tsconfig-strict.js';
import type { TestContext } from 'node:test';

function lines(file: string, source: string, ruleId: string): (number | undefined)[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return checkTypeSafetyHygiene(sourceFile, file)
    .filter((finding) => finding.ruleId === ruleId)
    .map((finding) => finding.line);
}

test('focused-test-committed flags .only forms in test files', () => {
  const source = [
    "describe.only('a', () => {});",
    "it.only('b', () => {});",
    "test.only('c', () => {});",
    "suite.only('d', () => {});",
    "test.describe.only('e', () => {});",
    "describe.only.each([1])('f', () => {});",
    "fit('g', () => {});",
    "fdescribe('h', () => {});",
  ].join('\n');
  assert.deepEqual(lines('src/a.test.ts', source, 'focused-test-committed'), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('focused-test-committed leaves other code alone', () => {
  assert.deepEqual(lines('src/a.test.ts', "it('b', () => {});\nit.skip('c', () => {});", 'focused-test-committed'), []);
  assert.deepEqual(
    lines('src/a.test.ts', "const text = 'it.only(x)';\n// describe.only('x')", 'focused-test-committed'),
    [],
  );
  assert.deepEqual(lines('src/a.test.ts', 'fit(model, data);\nconst only = it.only;', 'focused-test-committed'), []);
  assert.deepEqual(lines('src/a.test.ts', 'cache.only(1);\nstore.test.only(2);', 'focused-test-committed'), []);
});

test('focused-test-committed ignores files that are not tests', () => {
  assert.deepEqual(lines('src/runner.ts', "it.only('b', () => {});", 'focused-test-committed'), []);
  assert.deepEqual(lines('test/fixtures/a.test.ts', "it.only('b', () => {});", 'focused-test-committed'), []);
  assert.deepEqual(lines('test/unit/a.ts', "it.only('b', () => {});", 'focused-test-committed'), [1]);
});

test('ts-suppression-without-reason flags bare directives', () => {
  const source = [
    '// @ts-ignore',
    'a();',
    '// @ts-expect-error',
    'b();',
    '/* @ts-ignore */',
    'c();',
    '// @ts-nocheck',
    '// @ts-ignore -',
    'd();',
  ].join('\n');
  assert.deepEqual(lines('src/a.ts', source, 'ts-suppression-without-reason'), [1, 3, 5, 7, 8]);
});

test('ts-suppression-without-reason accepts a reason and ignores look-alikes', () => {
  const source = [
    '// @ts-ignore legacy typings omit this',
    'a();',
    '// @ts-expect-error: the library types are wrong',
    'b();',
    '/* @ts-ignore see issue 12 */',
    'c();',
    '// @ts-nocheck - generated glue',
    "const text = '// @ts-ignore';",
    '// the @ts-ignore flag is described here',
    '// @ts-check',
  ].join('\n');
  assert.deepEqual(lines('src/a.ts', source, 'ts-suppression-without-reason'), []);
});

test('ts-suppression-without-reason skips declaration files and fixtures', () => {
  assert.deepEqual(lines('types/a.d.ts', '// @ts-ignore\nexport {};', 'ts-suppression-without-reason'), []);
  assert.deepEqual(lines('test/fixtures/a.ts', '// @ts-ignore\nexport {};', 'ts-suppression-without-reason'), []);
});

test('double-type-assertion flags casts through unknown and any', () => {
  const source = [
    'const a = value as unknown as User;',
    'const b = value as any as User;',
    'const c = (value as unknown) as User;',
    'const d = <User>(value as unknown);',
  ].join('\n');
  assert.deepEqual(lines('src/a.ts', source, 'double-type-assertion'), [1, 2, 3]);
});

test('double-type-assertion leaves single and typed casts alone', () => {
  const source = [
    'const a = value as User;',
    'const b = value as unknown;',
    'const c = (value as Base) as User;',
    'const d = value as const;',
    "const e = 'x as unknown as T';",
  ].join('\n');
  assert.deepEqual(lines('src/a.ts', source, 'double-type-assertion'), []);
  assert.deepEqual(lines('src/a.js', 'const a = value;', 'double-type-assertion'), []);
});

function writeTsconfigs(context: TestContext, configs: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsconfig-strict-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(configs)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

function tsconfigFindings(context: TestContext, configs: Record<string, string>): string[] {
  const root = writeTsconfigs(context, configs);
  return checkTsconfigStrictness(root, Object.keys(configs)).map((finding) => `${finding.file}:${finding.line}`);
}

test('tsconfig-strict-disabled flags strict false and bare strict opt-outs', (context) => {
  const found = tsconfigFindings(context, {
    'tsconfig.json': '{\n  // loose\n  "compilerOptions": {\n    "strict": false\n  }\n}',
    'packages/a/tsconfig.json': '{ "compilerOptions": { "noImplicitAny": false } }',
    'packages/b/tsconfig.build.json': '{ "compilerOptions": {\n "strictNullChecks": false } }',
  });
  assert.deepEqual(found, ['tsconfig.json:4', 'packages/a/tsconfig.json:1', 'packages/b/tsconfig.build.json:2']);
});

test('tsconfig-strict-disabled accepts strict projects and explicit strict', (context) => {
  const found = tsconfigFindings(context, {
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "noImplicitAny": false } }',
    'a/tsconfig.json': '{ "extends": "../tsconfig.json" }',
    'b/tsconfig.json': '{ "compilerOptions": { "target": "es2022", "strictPropertyInitialization": false } }',
    'c/tsconfig.json': '{ "compilerOptions": { "strict": true, "strictNullChecks": false } }',
    'd/tsconfig.json': 'not json at all {',
  });
  assert.deepEqual(found, []);
});

test('tsconfig-strict-disabled skips test, fixture and template configs', (context) => {
  const loose = '{ "compilerOptions": { "strict": false } }';
  const found = tsconfigFindings(context, {
    'tsconfig.test.json': loose,
    'tsconfig.spec.json': loose,
    'test/tsconfig.json': loose,
    'fixtures/app/tsconfig.json': loose,
    'templates/app/tsconfig.json': loose,
    'examples/app/tsconfig.json': loose,
    'jsconfig.json': loose,
  });
  assert.deepEqual(found, []);
});

test('double-type-assertion skips tests and generated code', () => {
  const source = 'const a = value as unknown as User;';
  assert.deepEqual(lines('src/a.test.ts', source, 'double-type-assertion'), []);
  assert.deepEqual(lines('src/generated/graphql.ts', source, 'double-type-assertion'), []);
  assert.deepEqual(lines('src/client.generated.ts', source, 'double-type-assertion'), []);
});
