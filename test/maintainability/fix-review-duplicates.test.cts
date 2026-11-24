// Duplicate-implementation fixes for private methods repeated across controllers: reuse of a
// function the project already exports, calls that replace a one-line delegating method, and copies
// that differ only in comments or
// `!` against `?.`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { applyFix } from '../../editor/apply-fix.cjs';
import { attachSiteFixes, buildFix, createFileCache } from '../../lib/maintainability/site-fix.cjs';
import { extractImplementations } from '../../lib/maintainability/duplicates.cjs';
import type { TestContext } from 'node:test';
import { fixOf } from '../types/finding-fix.cjs';
import type { FindingFix, FixChange } from '../../lib/shared/types.cjs';
import type { LocatedFinding } from '../../lib/maintainability/types/module-graph.cjs';
import type { FileMap } from '../types/project-files.cjs';

function writeProject(context: TestContext, files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-review-duplicates-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

const bodyLines = [
  "    const header = request.headers['accept-language'];",
  "    const lang = header?.split(',')[0]?.toLowerCase();",
  '    if (lang && SUPPORTED.includes(lang)) return lang;',
  "    return 'en';",
];

function controller(name: string, depth: number, useLines: readonly string[]) {
  const up = '../'.repeat(depth);
  return [
    `import { SUPPORTED } from '${up}languages';`,
    `import type { Request } from '${up}http';`,
    `export class ${name} {`,
    '  private detectLanguage(request: Request): string {',
    ...bodyLines,
    '  }',
    '',
    '  greet(request: Request): string {',
    ...useLines,
    '  }',
    '}',
    '',
  ].join('\n');
}

const directUse = ["    return 'hello:' + this.detectLanguage(request);"];
const support = {
  'src/http.ts': 'export interface Request { headers: Record<string, string | undefined> }\n',
  'src/languages.ts': "export const SUPPORTED: string[] = ['en', 'ar'];\n",
};

function controllersWith(useLines: readonly string[]) {
  return {
    'src/orders/orders.controller.ts': controller('OrdersController', 1, useLines),
    'src/users/users.controller.ts': controller('UsersController', 1, useLines),
    'src/users/admin/admin.controller.ts': controller('AdminController', 2, useLines),
  };
}

function finding(files: FileMap): LocatedFinding {
  const marker = 'detectLanguage(request: Request)';
  const sites = Object.entries(files).map(([file, text]) => {
    const lines = text.split('\n');
    const line = lines.findIndex((row) => row.includes(marker));
    return { file, line: line + 1, column: lines[line].indexOf(marker) + 1 };
  });
  return {
    ...sites[0],
    related: sites.slice(1),
    ruleId: 'duplicate-implementation',
    message: 'duplicate implementation',
  };
}

function fixFor(root: string, files: FileMap): FindingFix {
  const fix = buildFix(finding(files), createFileCache(root));
  assert.ok(fix, 'expected a fix');
  return fix;
}

function applyTo(root: string, fix: Pick<FindingFix, 'changes'>) {
  const result = applyFix(fix, {
    readFile: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
    writeFile: (file, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    },
  });
  assert.equal(result.error, undefined);
}

function read(root: string, file: string) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function createsFile(fix: Pick<FindingFix, 'changes'>) {
  return fix.changes.some((change: FixChange) => change.create);
}

function typeErrors(root: string, files: readonly string[]) {
  const options = { strict: true, noUnusedLocals: true, noEmit: true, target: ts.ScriptTarget.ES2022, types: [] };
  const program = ts.createProgram(
    files.map((file) => path.join(root, file)),
    options,
  );
  return ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' '));
}

function existingHelper(returned: string) {
  return [
    "import { SUPPORTED } from './languages';",
    "import type { Request } from './http';",
    '',
    'export function languageOf(request: Request): string {',
    ...bodyLines.map((line) => line.slice(2).replace("'en'", `'${returned}'`)),
    '}',
    '',
  ].join('\n');
}

test('callers of an identical private method call the shared function and the method disappears', (context) => {
  const controllers = controllersWith(directUse);
  const root = writeProject(context, { ...support, ...controllers });
  applyTo(root, fixFor(root, controllers));
  const admin = read(root, 'src/users/admin/admin.controller.ts');
  assert.doesNotMatch(admin, /private detectLanguage|SUPPORTED/);
  assert.match(admin, /return 'hello:' \+ detectLanguage\(request\);/);
  const all = [...Object.keys(support), ...Object.keys(controllers), 'src/detect-language.ts'];
  assert.deepEqual(typeErrors(root, all), []);
});

test('a method used as a value keeps a delegating wrapper', (context) => {
  const controllers = controllersWith(['    const resolve = this.detectLanguage;', '    return resolve(request);']);
  const root = writeProject(context, { ...support, ...controllers });
  applyTo(root, fixFor(root, controllers));
  const admin = read(root, 'src/users/admin/admin.controller.ts');
  assert.match(admin, /private detectLanguage\(request: Request\): string \{\n {4}return detectLanguage\(request\);/);
});

test('a function the project already exports with the same implementation is imported, not copied', (context) => {
  const controllers = controllersWith(directUse);
  const root = writeProject(context, { ...support, ...controllers, 'src/language-of.ts': existingHelper('en') });
  const fix = fixFor(root, controllers);
  assert.equal(createsFile(fix), false);
  applyTo(root, fix);
  assert.equal(fs.existsSync(path.join(root, 'src/detect-language.ts')), false);
  const orders = read(root, 'src/orders/orders.controller.ts');
  assert.match(orders, /import \{ languageOf \} from '\.\.\/language-of';/);
  assert.match(orders, /return 'hello:' \+ languageOf\(request\);/);
  const all = [...Object.keys(support), ...Object.keys(controllers), 'src/language-of.ts'];
  assert.deepEqual(typeErrors(root, all), []);
});

test('an exported function with a different body is not reused', (context) => {
  const controllers = controllersWith(directUse);
  const root = writeProject(context, { ...support, ...controllers, 'src/language-of.ts': existingHelper('ar') });
  assert.equal(createsFile(fixFor(root, controllers)), true);
});

function keysOf(source: string) {
  const file = ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true);
  const extracted = extractImplementations(file, 'src/sample.ts');
  assert.ok(extracted);
  return extracted.implementations.map((implementation) => implementation.key);
}

const chainBody = (access: string) => `function read(input: { a?: { list: string[] } }, name: string) {
  const parts = ${access}.list;
  const first = parts.length ? parts[0] : name;
  const lowered = first.toLowerCase();
  if (lowered === name) return parts.map((part) => part.trim());
  return [lowered];
}
`;

test('copies that differ only in comments or in a non-null assertion against an optional chain group together', () => {
  const [optional] = keysOf(chainBody('input.a?'));
  const [asserted] = keysOf(chainBody('input.a!'));
  const [commented] = keysOf(chainBody('input.a?').replace('const parts', '// Split first.\n  const parts'));
  assert.ok(optional);
  assert.equal(asserted, optional);
  assert.equal(commented, optional);
});

test('an unguarded access stays distinct from an optional chain', () => {
  const [optional] = keysOf(chainBody('input.a?'));
  const [unguarded] = keysOf(chainBody('input.a'));
  assert.ok(unguarded);
  assert.notEqual(unguarded, optional);
});

const guardBody = (guard: string) => `function pick(values: string[], name: string) {
  const first = values.length ? values[0] : name;
  const lowered = first.toLowerCase();
  ${guard}
  return values.map((value) => value.trim());
}
`;

test('a block holding one statement groups with that statement, but not when it declares a name', () => {
  const [braced] = keysOf(guardBody('if (lowered === name) { return [lowered]; }'));
  const [bare] = keysOf(guardBody('if (lowered === name) return [lowered];'));
  const [loopBraced] = keysOf(guardBody('for (const value of values) { value.trim(); }'));
  const [loopBare] = keysOf(guardBody('for (const value of values) value.trim();'));
  const [scopedBlock] = keysOf(guardBody('if (lowered === name) { const copy = [lowered]; }'));
  assert.ok(braced);
  assert.equal(braced, bare);
  assert.equal(loopBraced, loopBare);
  assert.notEqual(scopedBlock, keysOf(guardBody('if (lowered === name) const copy = [lowered];'))[0]);
});

test('function bodies keep their block', () => {
  const [braced] = keysOf(guardBody('if (lowered === name) { return [lowered]; }'));
  const [arrowBare] = keysOf(guardBody('const unused = (): void => { name.trim(); };'));
  assert.notEqual(braced, arrowBare);
});

test('two duplicate groups of one helper name with different bodies both get a module in one scan', (context) => {
  const larger = controllersWith(directUse);
  const smaller = Object.fromEntries(
    ['cart', 'wishlist'].map((name) => [
      `src/${name}/${name}.controller.ts`,
      controller(name[0].toUpperCase() + name.slice(1) + 'Controller', 1, directUse).replace("'en'", "'ar'"),
    ]),
  );
  const root = writeProject(context, { ...support, ...larger, ...smaller });
  const findings = [finding(smaller), finding(larger)];
  attachSiteFixes(findings, root);
  const created = findings.map((item) => fixOf(item).changes.find((change: FixChange) => change.create)?.file);
  assert.deepEqual(created, ['src/detect-language-2.ts', 'src/detect-language.ts']);
  assert.match(String(fixOf(findings[0]).note), /src\/detect-language\.ts already holds a different detectLanguage/);
  for (const item of findings) applyTo(root, fixOf(item));
  assert.match(read(root, 'src/detect-language-2.ts'), /return 'ar';/);
  assert.match(read(root, 'src/cart/cart.controller.ts'), /from '\.\.\/detect-language-2';/);
  const all = [...Object.keys(support), ...Object.keys(larger), ...Object.keys(smaller)];
  assert.deepEqual(typeErrors(root, [...all, 'src/detect-language.ts', 'src/detect-language-2.ts']), []);
});
