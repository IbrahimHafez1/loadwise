import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { checkSwallowedErrors } from '../../lib/maintainability/swallowed-errors.js';
import { createEntryPoints } from '../../lib/maintainability/entry-points.js';

function check(source: string, file = 'src/example.ts') {
  return checkSwallowedErrors(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), file);
}

test('swallowed-error stays quiet for defaults, retry loops, middleware and vendored files', () => {
  const quiet = [
    'function f(d) { let body = "{}"; try { if (d) { body = JSON.stringify(d); } } catch (e) { logger.error("x"); } use(body); }',
    'async function f() { while (true) { try { await probe(); return; } catch (e) { console.error(e); } await sleep(1); } }',
    'function mw(req, res, next) { try { start(req); } catch (e) { logger.warn("x"); } next(); }',
  ];
  for (const source of quiet) assert.equal(check(source).length, 0, source);
  assert.equal(check('try { a(); } catch {}', 'src/assets/private/three.js').length, 0);
});

test('swallowed-error keeps reporting a log-only catch, and makes parse fallbacks contextual', () => {
  assert.equal(check('function f() { try { work(); } catch (e) { console.error(e); } done(); }').length, 1);
  const [parsed] = check('function f() { try { JSON.parse(x); } catch (e) { console.error(e); } done(); }');
  assert.ok(parsed.contextualReason);
});

test('files named by tool configs, read by folder and placeholders are entry points', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-entry-'));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  try {
    write('package.json', '{"name":"app"}');
    write(
      'vitest.config.ts',
      'export default { test: { globalSetup: ["./it/global.ts"], setupFiles: "./it/setup.ts" } };',
    );
    write('it/global.ts', 'export default function g() {}');
    write('it/setup.ts', 'export const s = 1;');
    write('rollup.config.js', "export default { input: 'guest/index.ts' };");
    write('guest/index.ts', 'export const g = 1;');
    write('src/read.ts', "import fs from 'fs'; fs.readFileSync('./data/static/fixes/' + key);");
    write('data/static/fixes/one.ts', 'export const one = 1;');
    write('src/empty.ts', '// kept for the build\n');
    write('src/dead.ts', 'export const dead = 1;');
    const files = [
      'vitest.config.ts',
      'rollup.config.js',
      'it/global.ts',
      'it/setup.ts',
      'guest/index.ts',
      'src/read.ts',
      'data/static/fixes/one.ts',
      'src/empty.ts',
      'src/dead.ts',
    ];
    const { isEntryPoint } = createEntryPoints(root, ['package.json', ...files], files);
    for (const file of ['it/global.ts', 'it/setup.ts', 'guest/index.ts', 'data/static/fixes/one.ts', 'src/empty.ts'])
      assert.ok(isEntryPoint(file), file);
    assert.equal(isEntryPoint('src/dead.ts'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('files named by mocha options, a package.json test config or express.static are entry points', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-mocha-'));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  try {
    write('package.json', JSON.stringify({ name: 'app', mocha: { require: ['./hooks/register.js'] } }));
    write('.mocharc.json', JSON.stringify({ spec: ['specs/**/*.js'] }));
    write('hooks/register.js', 'global.ready = true;');
    write('specs/a/one.js', 'it("one", () => {});');
    write('src/server.ts', "import express from 'express'; express.static('public/assets/css');");
    write('public/assets/css/theme.ts', 'export const theme = 1;');
    write('src/dead.ts', 'export const dead = 1;');
    const files = ['hooks/register.js', 'specs/a/one.js', 'src/server.ts', 'public/assets/css/theme.ts', 'src/dead.ts'];
    const { isEntryPoint } = createEntryPoints(root, ['package.json', '.mocharc.json', ...files], files);
    for (const file of ['hooks/register.js', 'specs/a/one.js']) assert.ok(isEntryPoint(file), file);
    assert.ok(isEntryPoint('public/assets/css/theme.ts'));
    assert.equal(isEntryPoint('src/dead.ts'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
