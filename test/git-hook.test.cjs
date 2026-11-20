'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const bin = path.resolve(__dirname, '../bin/warden-maint.cjs');
const blockStart = '# >>> warden-maint pre-commit';
const shellAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function tempRepo(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'maintainability-hook-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function initHook(root, ...hookArgs) {
  const result = spawnSync(process.execPath, [bin, 'agent', 'init', ...hookArgs], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function hookPath(root) {
  return path.join(root, '.git', 'hooks', 'pre-commit');
}

test('--hook defaults to warn, writes an executable hook and is idempotent', (context) => {
  const root = tempRepo(context);
  initHook(root, '--hook');
  const first = fs.readFileSync(hookPath(root), 'utf8');
  assert.match(first, /^#!\/bin\/sh\n/);
  assert.match(first, /--staged \. \|\| true/);
  assert.ok(first.includes('not installed here, skipped'));
  assert.ok(!first.includes('exit 0'));
  if (process.platform !== 'win32') assert.ok(fs.statSync(hookPath(root)).mode & 0o100);
  initHook(root, '--hook', 'warn');
  assert.equal(fs.readFileSync(hookPath(root), 'utf8'), first);
});

test('switching to block replaces only the managed block and keeps other hook content', (context) => {
  const root = tempRepo(context);
  fs.mkdirSync(path.dirname(hookPath(root)), { recursive: true });
  fs.writeFileSync(hookPath(root), '#!/bin/sh\necho before\n');
  initHook(root, '--hook', 'warn');
  initHook(root, '--hook', 'block');
  const text = fs.readFileSync(hookPath(root), 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\necho before\n'));
  assert.equal(text.split(blockStart).length, 2);
  assert.match(text, /--staged \. \|\| exit 1/);
  assert.match(text, /fi \) \|\| exit 1/);
  initHook(root, '--hook', 'off');
  assert.equal(fs.readFileSync(hookPath(root), 'utf8'), '#!/bin/sh\necho before\n');
});

test('--hook off deletes a hook that only held our block', (context) => {
  const root = tempRepo(context);
  initHook(root, '--hook', 'block');
  initHook(root, '--hook', 'off');
  assert.equal(fs.existsSync(hookPath(root)), false);
});

test('a .husky folder at the git root receives the hook', (context) => {
  const root = tempRepo(context);
  fs.mkdirSync(path.join(root, '.husky'));
  initHook(root, '--hook', 'block');
  assert.ok(fs.readFileSync(path.join(root, '.husky', 'pre-commit'), 'utf8').includes(blockStart));
  assert.equal(fs.existsSync(hookPath(root)), false);
});

test('core.hooksPath is honoured', (context) => {
  const root = tempRepo(context);
  git(root, 'config', 'core.hooksPath', 'custom-hooks');
  initHook(root, '--hook', 'block');
  assert.ok(fs.readFileSync(path.join(root, 'custom-hooks', 'pre-commit'), 'utf8').includes(blockStart));
});

test('lefthook is never edited; the command to add is printed', (context) => {
  const root = tempRepo(context);
  fs.writeFileSync(path.join(root, 'lefthook.yml'), 'pre-commit:\n');
  const output = initHook(root, '--hook', 'block');
  assert.match(output, /node_modules\/\.bin\/warden-maint --staged \. \|\| exit 1/);
  assert.match(initHook(root, '--hook', 'warn'), /--staged \. \|\| true/);
  assert.equal(fs.readFileSync(path.join(root, 'lefthook.yml'), 'utf8'), 'pre-commit:\n');
  assert.equal(fs.existsSync(hookPath(root)), false);
});

test('a project below the git root cds into its folder', (context) => {
  const root = tempRepo(context);
  const project = path.join(root, 'packages', 'api');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  initHook(project, '--hook', 'block');
  assert.ok(fs.readFileSync(hookPath(root), 'utf8').includes('cd "packages/api"'));
});

test('agent init without --hook leaves git hooks alone and mentions commits in AGENTS.md', (context) => {
  const root = tempRepo(context);
  initHook(root);
  assert.equal(fs.existsSync(hookPath(root)), false);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /--staged/);
});

function installFakeChecker(root, exitCode) {
  const binFolder = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(binFolder, { recursive: true });
  const script = path.join(binFolder, 'warden-maint');
  fs.writeFileSync(script, `#!/bin/sh\necho "checker ran: $*"\nexit ${exitCode}\n`);
  fs.chmodSync(script, 0o755);
}

function runHook(root) {
  return spawnSync('sh', [hookPath(root)], { cwd: root, encoding: 'utf8' });
}

test('block fails the hook when the checker fails; warn does not', { skip: !shellAvailable }, (context) => {
  const root = tempRepo(context);
  installFakeChecker(root, 1);
  initHook(root, '--hook', 'block');
  const blocked = runHook(root);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /checker ran: --staged \./);
  initHook(root, '--hook', 'warn');
  assert.equal(runHook(root).status, 0);
});

test('the hook skips quietly when the package is not installed', { skip: !shellAvailable }, (context) => {
  const root = tempRepo(context);
  initHook(root, '--hook', 'block');
  const result = runHook(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /not installed here, skipped/);
});

const legacyHook =
  '#!/bin/sh\necho before\n\n# >>> maintainability-check pre-commit (managed by `maintainability-check agent init --hook`)\n' +
  'node_modules/.bin/maintainability-check --staged .\n# <<< maintainability-check pre-commit\n';

test('re-running init replaces a block with the old markers instead of duplicating it', (context) => {
  const root = tempRepo(context);
  fs.mkdirSync(path.dirname(hookPath(root)), { recursive: true });
  fs.writeFileSync(hookPath(root), legacyHook);
  initHook(root, '--hook', 'warn');
  const text = fs.readFileSync(hookPath(root), 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\necho before\n'));
  assert.ok(!text.includes('maintainability-check'));
  assert.equal(text.split(blockStart).length, 2);
});

test('--hook off removes a block with the old markers', (context) => {
  const root = tempRepo(context);
  fs.mkdirSync(path.dirname(hookPath(root)), { recursive: true });
  fs.writeFileSync(hookPath(root), legacyHook);
  initHook(root, '--hook', 'off');
  assert.equal(fs.readFileSync(hookPath(root), 'utf8'), '#!/bin/sh\necho before\n');
});
