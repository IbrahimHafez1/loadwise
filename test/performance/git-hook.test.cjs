'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bin = path.resolve(__dirname, '../../bin/warden-backend.cjs');
const blockMarker = '# >>> warden-backend pre-commit';
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function repository(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-hook-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const installHook = (...args) =>
    spawnSync(process.execPath, [bin, 'agent', 'init', ...args], { cwd: root, encoding: 'utf8' });
  const hookFile = path.join(root, '.git', 'hooks', 'pre-commit');
  return { root, installHook, hookFile };
}

test('--hook block writes an executable hook once and rerunning does not duplicate it', (context) => {
  const { installHook, hookFile } = repository(context);
  assert.equal(installHook('--hook', 'block').status, 0);
  const first = fs.readFileSync(hookFile, 'utf8');
  assert.ok(first.startsWith('#!/bin/sh\n'));
  assert.match(first, /--staged \|\| exit 1/);
  assert.doesNotMatch(first, /exit 0/);
  if (process.platform !== 'win32') assert.ok(fs.statSync(hookFile).mode & 0o100);
  installHook('--hook', 'block');
  assert.equal(fs.readFileSync(hookFile, 'utf8'), first);
  assert.equal(first.match(/>>> warden-backend pre-commit/g).length, 1);
});

test('--hook without a value means warn, and switching mode replaces only the block', (context) => {
  const { installHook, hookFile } = repository(context);
  installHook('--hook');
  assert.match(fs.readFileSync(hookFile, 'utf8'), /--staged \|\| true/);
  installHook('--hook', 'block');
  const text = fs.readFileSync(hookFile, 'utf8');
  assert.match(text, /--staged \|\| exit 1/);
  assert.doesNotMatch(text, /\|\| true/);
});

test('an existing hook is kept and the block is appended; --hook off removes only the block', (context) => {
  const { installHook, hookFile } = repository(context);
  const original = '#!/bin/sh\necho other tool\n';
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, original);
  installHook('--hook', 'warn');
  const installed = fs.readFileSync(hookFile, 'utf8');
  assert.ok(installed.startsWith(original));
  assert.ok(installed.includes(blockMarker));
  assert.equal(installHook('--hook', 'off').status, 0);
  assert.equal(fs.readFileSync(hookFile, 'utf8'), original);
  assert.match(installHook('--hook', 'off').stdout, /No pre-commit block/);
});

test('.husky takes precedence and core.hooksPath is honoured', (context) => {
  const husky = repository(context);
  fs.mkdirSync(path.join(husky.root, '.husky'));
  husky.installHook('--hook', 'warn');
  assert.ok(fs.readFileSync(path.join(husky.root, '.husky', 'pre-commit'), 'utf8').includes(blockMarker));
  assert.equal(fs.existsSync(husky.hookFile), false);

  const custom = repository(context);
  spawnSync('git', ['config', 'core.hooksPath', 'custom-hooks'], { cwd: custom.root });
  custom.installHook('--hook', 'warn');
  assert.ok(fs.readFileSync(path.join(custom.root, 'custom-hooks', 'pre-commit'), 'utf8').includes(blockMarker));
});

test('lefthook is not edited; the command to add is printed', (context) => {
  const { root, installHook, hookFile } = repository(context);
  fs.writeFileSync(path.join(root, 'lefthook.yml'), 'pre-commit:\n  commands: {}\n');
  const result = installHook('--hook', 'block');
  assert.match(result.stdout, /node_modules\/\.bin\/warden-backend --staged/);
  assert.equal(fs.readFileSync(path.join(root, 'lefthook.yml'), 'utf8'), 'pre-commit:\n  commands: {}\n');
  assert.equal(fs.existsSync(hookFile), false);
});

test('a project below the git root is entered by the hook', (context) => {
  const { root } = repository(context);
  const projectDirectory = path.join(root, 'apps', 'api');
  fs.mkdirSync(projectDirectory, { recursive: true });
  fs.writeFileSync(path.join(projectDirectory, 'package.json'), '{}');
  const result = spawnSync(process.execPath, [bin, 'agent', 'init', '--hook', 'block'], {
    cwd: projectDirectory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), /cd "apps\/api" &&/);
});

test('the AGENTS.md block explains the commit hook', (context) => {
  const { root, installHook } = repository(context);
  installHook();
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /--no-verify/);
});

// Runs the generated hook with a fake checker that reports findings, to prove block fails and warn does not.
function runHook(root, hookFile, checkerExitCode) {
  const binDirectory = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(binDirectory, 'warden-backend'),
    `#!/bin/sh\necho checker ran\nexit ${checkerExitCode}\n`,
    {
      mode: 0o755,
    },
  );
  return spawnSync('sh', [hookFile], { cwd: root, encoding: 'utf8' });
}

test('block mode fails the hook when the checker fails, warn mode does not', { skip: !hasSh }, (context) => {
  const { root, installHook, hookFile } = repository(context);
  installHook('--hook', 'block');
  const blocked = runHook(root, hookFile, 1);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /checker ran/);
  assert.equal(runHook(root, hookFile, 0).status, 0);
  installHook('--hook', 'warn');
  assert.equal(runHook(root, hookFile, 1).status, 0);
});

test('the hook skips quietly when the checker is not installed', { skip: !hasSh }, (context) => {
  const { root, installHook, hookFile } = repository(context);
  installHook('--hook', 'block');
  const result = spawnSync('sh', [hookFile], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /not installed here, skipped/);
});

const legacyBlock = [
  '# >>> backend-perf-check pre-commit (managed by `backend-perf-check agent init --hook`)',
  'node_modules/.bin/backend-perf-check --staged || true',
  '# <<< backend-perf-check pre-commit',
].join('\n');

test('rerunning init replaces a block written under the old name instead of duplicating it', (context) => {
  const { installHook, hookFile } = repository(context);
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, `#!/bin/sh\necho other tool\n\n${legacyBlock}\n`);
  assert.equal(installHook('--hook', 'block').status, 0);
  const text = fs.readFileSync(hookFile, 'utf8');
  assert.ok(text.includes('echo other tool'));
  assert.ok(text.includes(blockMarker));
  assert.doesNotMatch(text, /backend-perf-check/);
});

test('--hook off removes a block written under the old name', (context) => {
  const { installHook, hookFile } = repository(context);
  const original = '#!/bin/sh\necho other tool\n';
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, `${original}\n${legacyBlock}\n`);
  assert.equal(installHook('--hook', 'off').status, 0);
  assert.equal(fs.readFileSync(hookFile, 'utf8'), original);
});
