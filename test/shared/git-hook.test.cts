import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { isolateHistory } from './history-test-state.cjs';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
isolateHistory();
const blockMarker = '# >>> loadwise pre-commit';
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function repository(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-hook-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const installHook = (...args: string[]) =>
    spawnSync(process.execPath, [bin, 'agent', 'init', ...args], { cwd: root, encoding: 'utf8' });
  const hookFile = path.join(root, '.git', 'hooks', 'pre-commit');
  return { root, installHook, hookFile };
}

test('--hook block writes an executable hook once and rerunning does not duplicate it', (context) => {
  const { installHook, hookFile } = repository(context);
  assert.equal(installHook('--hook', 'block').status, 0);
  const first = fs.readFileSync(hookFile, 'utf8');
  assert.ok(first.startsWith('#!/bin/sh\n'));
  assert.match(first, /node_modules\/\.bin\/loadwise check --staged \|\| exit 1/);
  assert.match(first, /fi \) \|\| exit 1/);
  assert.doesNotMatch(first, /exit 0/);
  if (process.platform !== 'win32') assert.ok(fs.statSync(hookFile).mode & 0o100);
  installHook('--hook', 'block');
  assert.equal(fs.readFileSync(hookFile, 'utf8'), first);
  assert.equal(first.match(/>>> loadwise pre-commit/g)?.length, 1);
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
  assert.match(installHook('--hook', 'off').stdout, /No loadwise pre-commit block to remove/);
});

test('--hook off deletes a hook that only held the loadwise block', (context) => {
  const { installHook, hookFile } = repository(context);
  installHook('--hook', 'block');
  assert.equal(installHook('--hook', 'off').status, 0);
  assert.equal(fs.existsSync(hookFile), false);
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
  assert.match(result.stdout, /cd "\." && node_modules\/\.bin\/loadwise check --staged$/m);
  assert.match(installHook('--hook', 'warn').stdout, /check --staged \|\| true/);
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

test('agent init without --hook leaves git hooks alone and the AGENTS.md block explains the commit hook', (context) => {
  const { root, installHook, hookFile } = repository(context);
  installHook();
  assert.equal(fs.existsSync(hookFile), false);
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /loadwise check --staged/);
  assert.match(agents, /--no-verify/);
});

test('perf agent init and maint agent init install the same single hook', (context) => {
  const { root, hookFile } = repository(context);
  for (const checker of ['perf', 'maint']) {
    const result = spawnSync(process.execPath, [bin, checker, 'agent', 'init', '--hook', 'block'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.readFileSync(hookFile, 'utf8').split(blockMarker).length, 2);
});

// Runs the generated hook with a fake checker that reports findings, to prove block fails and warn
// does not.
function runHook(root: string, hookFile: string, checkerExitCode: number) {
  const binDirectory = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(binDirectory, 'loadwise'),
    `#!/bin/sh\necho "checker ran: $*"\nexit ${checkerExitCode}\n`,
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
  assert.match(blocked.stdout, /checker ran: check --staged/);
  assert.equal(runHook(root, hookFile, 0).status, 0);
  installHook('--hook', 'warn');
  assert.equal(runHook(root, hookFile, 1).status, 0);
});

test('the hook skips quietly when the checker is not installed', { skip: !hasSh }, (context) => {
  const { root, installHook, hookFile } = repository(context);
  installHook('--hook', 'block');
  const result = spawnSync('sh', [hookFile], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /loadwise: not installed here, skipped/);
});

function legacyBlock(name: string) {
  return [
    `# >>> ${name} pre-commit (managed by \`${name} agent init --hook\`)`,
    `node_modules/.bin/${name} --staged || true`,
    `# <<< ${name} pre-commit`,
  ].join('\n');
}

test('rerunning init upgrades blocks written under every earlier name to one loadwise block', (context) => {
  const { installHook, hookFile } = repository(context);
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  const earlierBlocks = ['warden-backend', 'warden-maint', 'backend-perf-check', 'maintainability-check'].map(
    legacyBlock,
  );
  fs.writeFileSync(hookFile, `#!/bin/sh\necho other tool\n\n${earlierBlocks.join('\n\n')}\n\necho after\n`);
  assert.equal(installHook('--hook', 'block').status, 0);
  const text = fs.readFileSync(hookFile, 'utf8');
  assert.ok(text.startsWith(`#!/bin/sh\necho other tool\n\n${blockMarker}`));
  assert.ok(text.endsWith('# <<< loadwise pre-commit\n\necho after\n'));
  assert.equal(text.split(blockMarker).length, 2);
  assert.doesNotMatch(text, /warden-backend|warden-maint|backend-perf-check|maintainability-check/);
});

test('--hook off removes blocks written under earlier names', (context) => {
  const { installHook, hookFile } = repository(context);
  const original = '#!/bin/sh\necho other tool\n';
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, `${original}\n${legacyBlock('backend-perf-check')}\n\n${legacyBlock('warden-maint')}\n`);
  assert.equal(installHook('--hook', 'off').status, 0);
  assert.equal(fs.readFileSync(hookFile, 'utf8'), original);
});
