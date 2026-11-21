'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { applyFix } = require('../../lib/maintainability/apply-fix.cjs');
const { buildFix, createFileCache } = require('../../lib/maintainability/site-fix.cjs');

const body = `{
  const domain = settings.domain;
  const age = parseInt(expiry, 10) * 1000;
  const secure = !!domain || settings.secure;
  return { secure, sameSite: secure ? 'none' : 'lax', age, ...(domain ? { domain } : {}) };
}`;
const signature = '(expiry: string): CookieOptions => ';
const names = ['getAccessOptions', 'getRefreshOptions'];
const declarations = names.map((name) => 'export const ' + name + ' = ' + signature + body + ';');
const moduleSource = [
  'interface CookieOptions { age: number; secure: boolean; sameSite: string; domain?: string }',
  "export const settings = { domain: '', secure: false };",
  ...declarations,
].join('\n');

function project(context, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-duplicate-arrows-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = 'options.ts';
  fs.writeFileSync(path.join(root, file), text);
  const lines = text.split('\n');
  const locations = names.map((name) => {
    const index = lines.findIndex((line) => line.includes('const ' + name + ' ='));
    return { file, line: index + 1, column: lines[index].indexOf(name) + 1 };
  });
  const finding = { ...locations[0], related: locations.slice(1), ruleId: 'duplicate-implementation' };
  return buildFix(finding, createFileCache(root));
}

function evaluate(source) {
  const exports = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  new Function('exports', compiled.outputText)(exports);
  return exports;
}

test('exported arrow factories keep caller identity, lengths, independent mockability and per-call state', (context) => {
  const fix = project(context, moduleSource);
  assert.equal(fix.requiresReview, true);
  let after;
  const result = applyFix(fix, {
    readFile: () => moduleSource,
    writeFile: (_file, text) => {
      after = text;
    },
  });
  assert.equal(result.error, undefined);
  // Call before reaching the second export; the private function is hoisted.
  const withEarlyCall = after.replace(
    'export const getRefreshOptions',
    "export const early = getAccessOptions('2');\nexport const getRefreshOptions",
  );
  const original = evaluate(moduleSource);
  const rewritten = evaluate(withEarlyCall);
  assert.deepEqual(rewritten.early, original.getAccessOptions('2'));
  assert.notEqual(rewritten.getAccessOptions, rewritten.getRefreshOptions);
  for (const name of names) {
    assert.equal(rewritten[name].name, original[name].name);
    assert.equal(rewritten[name].length, original[name].length);
    assert.deepEqual(rewritten[name]('7'), original[name]('7'));
  }
  rewritten.settings.domain = original.settings.domain = 'school.example';
  rewritten.getAccessOptions = () => {
    throw new Error('mocked access export');
  };
  assert.deepEqual(rewritten.getRefreshOptions('4'), original.getRefreshOptions('4'));
  assert.equal(project(context, after), undefined);
});

test('arrow sharing refuses signature differences, changed literals, recursion, async, default parameters and colliding helper names', (context) => {
  const variants = [
    moduleSource.replace(signature, signature.replace('string', 'number')),
    moduleSource.replace('1000;', '999;'),
    moduleSource.replaceAll('const domain = settings.domain;', 'const domain = getAccessOptions(expiry).domain;'),
    moduleSource.replaceAll(signature, 'async ' + signature),
    moduleSource.replaceAll('expiry: string', "expiry: string = '1'"),
    moduleSource + '\nconst getAccessOptionsImplementation = 2;',
    moduleSource.replaceAll('settings.secure;', "eval('settings.secure');"),
    moduleSource.replaceAll('settings.secure;', 'this.secure;'),
  ];
  for (const source of variants) assert.equal(project(context, source), undefined);
});
