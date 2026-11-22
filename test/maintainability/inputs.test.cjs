'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { listFiles, createResolver } = require('../../lib/maintainability/inputs.cjs');

function fixture(context, files) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'maintainability-inputs-'));
  context.after(() => {
    assert.equal(path.dirname(root), path.resolve(base));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return root;
}

function git(directory, ...args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
}

test('Git inventory includes tracked and new files and drops missing, excluded, and generated files', (context) => {
  const root = fixture(context, {
    '.gitignore': 'ignored.py\n',
    'src/user.ts': '',
    'src/new.go': '',
    'src/deleted.ts': '',
    'src/exclude.ts': '',
    'src/ignored.py': '',
    'dist/output.ts': '',
    'assets/bundle.min.js': '',
    'assets/bundle.js.map': '',
    '.yarn/releases/yarn-4.9.2.cjs': '',
    'src/deep/keep.py': '',
    'src/deeper/other.py': '',
  });
  git(root, 'init', '-q');
  git(root, 'add', '--', 'src/user.ts', 'src/deleted.ts');
  fs.unlinkSync(path.join(root, 'src/deleted.ts'));
  assert.deepEqual(listFiles(root, ['src/deep', 'src/exclude.ts']), [
    '.gitignore',
    'src/deeper/other.py',
    'src/new.go',
    'src/user.ts',
  ]);
  assert.deepEqual(listFiles(path.join(root, 'src'), ['deep', 'exclude.ts']), ['deeper/other.py', 'new.go', 'user.ts']);
});

test('plain working folders discover nested Git repositories while honoring each repository ignore file', (context) => {
  const root = fixture(context, {
    'notes.md': '',
    'api/.gitignore': 'secret.py\n',
    'api/service.py': '',
    'api/secret.py': '',
    'packages/app/.gitignore': 'unused.go\n',
    'packages/app/main.go': '',
    'packages/app/unused.go': '',
    'dist/output.ts': '',
    'Lib/venv/main.py': '',
    'runtime/venv/pyvenv.cfg': '',
    'runtime/venv/library.py': '',
    'local-exclude/drop.py': '',
  });
  git(path.join(root, 'api'), 'init', '-q');
  git(path.join(root, 'packages/app'), 'init', '-q');
  assert.deepEqual(listFiles(root, ['local-exclude']), [
    'Lib/venv/main.py',
    'api/.gitignore',
    'api/service.py',
    'notes.md',
    'packages/app/.gitignore',
    'packages/app/main.go',
  ]);
});

test('a replaced tracked directory cannot pull external files into the inventory', (context) => {
  const base = fixture(context, { 'app/stale/handler.ts': '', 'outside/handler.ts': '' });
  const root = path.join(base, 'app');
  git(root, 'init', '-q');
  git(root, 'add', '--', 'stale/handler.ts');
  const stale = path.join(root, 'stale');
  fs.unlinkSync(path.join(stale, 'handler.ts'));
  fs.rmdirSync(stale);
  try {
    fs.symlinkSync(path.join(base, 'outside'), stale, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return context.skip('Directory links unavailable');
    throw error;
  }
  assert.deepEqual(listFiles(root), []);
});

test('nearest inherited aliases and emitted .js imports resolve only to inventoried implementations', (context) => {
  const root = fixture(context, {
    'tsconfig.json': '{"extends":"./configs/base.json"}',
    'configs/base.json': '{"compilerOptions":{"baseUrl":"..","paths":{"@core/*":["src/core/*"]}}}',
    'src/entry.ts': '',
    'src/core/item.ts': '',
    'src/core/types.d.ts': '',
    'feature/jsconfig.json':
      '{"extends":"../configs/base.json","compilerOptions":{"baseUrl":".","verbatimModuleSyntax":true,"paths":{"@core/*":["local/*"]}}}',
    'feature/entry.js': '',
    'feature/local/item.ts': '',
    'feature/local/missing.ts': '',
    'node_modules/library/package.json': '{"main":"index.js"}',
    'node_modules/library/index.js': '',
  });
  const files = new Set(listFiles(root, ['feature/local/missing.ts']));
  const resolve = createResolver(root, files);
  const primary = path.join(root, 'src/entry.ts');
  const nested = path.join(root, 'feature/entry.js');
  assert.equal(resolve.optionsFor(nested).verbatimModuleSyntax, true);
  assert.equal(resolve.optionsFor(primary).verbatimModuleSyntax, undefined);
  assert.equal(resolve('@core/item', primary), 'src/core/item.ts');
  assert.equal(resolve('./core/item.js', primary), 'src/core/item.ts');
  assert.equal(resolve('@core/item', nested), 'feature/local/item.ts');
  assert.equal(resolve('@core/missing', nested), undefined);
  assert.equal(resolve('@core/types', primary), undefined);
  assert.equal(resolve('library', primary), undefined);
  assert.equal(resolve('node:fs', primary), undefined);
});

test('a base config from an uninstalled package keeps local settings while a missing relative base fails', (context) => {
  const root = fixture(context, {
    'tsconfig.json':
      '{"extends":"@workspace/tsconfig/library.json","compilerOptions":{"baseUrl":".","paths":{"@core/*":["src/core/*"]}}}',
    'src/entry.ts': '',
    'src/core/item.ts': '',
  });
  const resolve = createResolver(root, new Set(listFiles(root)));
  assert.equal(resolve('@core/item', path.join(root, 'src/entry.ts')), 'src/core/item.ts');

  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"extends":"./configs/missing.json"}');
  const broken = createResolver(root, new Set(listFiles(root)));
  assert.throws(() => broken('./core/item', path.join(root, 'src/entry.ts')), /Invalid compiler configuration/);
});

test('conditional package imports respect the usage-site resolution mode', (context) => {
  const source = "import '#impl'; import value = require('#impl');";
  const root = fixture(context, {
    'package.json': '{"type":"module","imports":{"#impl":{"import":"./esm.js","require":"./cjs.js"}}}',
    'tsconfig.json': '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
    'entry.ts': source,
    'esm.ts': '',
    'cjs.ts': '',
  });
  const filename = path.join(root, 'entry.ts');
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const resolve = createResolver(root, listFiles(root));
  assert.equal(resolve('#impl', filename, parsed.statements[0].moduleSpecifier), 'esm.ts');
  assert.equal(resolve('#impl', filename, parsed.statements[1].moduleReference.expression), 'cjs.ts');
});

test('build-output folder names are skipped only at the root or beside a manifest, not as source folders', (context) => {
  const root = fixture(context, {
    'build/out.ts': '',
    'packages/app/package.json': '{}',
    'packages/app/dist/out.ts': '',
    'packages/app/src/index.ts': '',
    'src/build/plan.ts': '',
    'src/vendor/client.ts': '',
    'src/coverage/report.ts': '',
  });
  assert.deepEqual(listFiles(root), [
    'packages/app/package.json',
    'packages/app/src/index.ts',
    'src/build/plan.ts',
    'src/coverage/report.ts',
    'src/vendor/client.ts',
  ]);
});
