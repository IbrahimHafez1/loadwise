'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.join(__dirname, '..', '..');
const hookScript = path.join(repositoryRoot, 'plugin', 'hooks', 'check-edited-file.cjs');

const readJson = (...segments) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, ...segments), 'utf8'));

function makeProject(fakeBinarySource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-hook-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'notes.md'), '# notes\n');
  if (fakeBinarySource !== undefined) {
    const binDirectory = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(binDirectory, 'loadwise'), `#!/usr/bin/env node\n${fakeBinarySource}`);
  }
  return root;
}

function runHook(root, relativeFile, environment = {}) {
  const input = JSON.stringify({
    cwd: root,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(root, relativeFile) },
  });
  return spawnSync(process.execPath, [hookScript], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

const FAKE_WITH_FINDINGS = `
const findings = process.argv[2] === 'perf'
  ? [{ file: 'src/a.ts', line: 3, ruleId: 'array-repeated-find', id: 'abc123', message: 'slow find', fixable: true },
     { file: 'src/other.ts', line: 1, ruleId: 'x', id: 'zzz', message: 'other file' }]
  : [];
console.log(JSON.stringify({ findings }));
process.exit(1);
`;

test('plugin manifests are valid JSON with the required fields', () => {
  const plugin = readJson('plugin', '.claude-plugin', 'plugin.json');
  const marketplace = readJson('.claude-plugin', 'marketplace.json');
  assert.equal(plugin.name, 'loadwise');
  assert.ok(plugin.version && plugin.description);
  assert.equal(marketplace.name, 'loadwise');
  assert.ok(marketplace.owner.name);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.ok(fs.existsSync(path.join(repositoryRoot, marketplace.plugins[0].source, '.claude-plugin', 'plugin.json')));
});

test('hooks.json runs the hook script after Edit, Write and MultiEdit', () => {
  const { hooks } = readJson('plugin', 'hooks', 'hooks.json');
  const [entry] = hooks.PostToolUse;
  assert.equal(entry.matcher, 'Edit|Write|MultiEdit');
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/check-edited-file\.cjs/);
});

test('a non-TS/JS file is skipped silently', () => {
  const result = runHook(makeProject(FAKE_WITH_FINDINGS), 'src/notes.md');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a project without a local loadwise is skipped silently', () => {
  const result = runHook(makeProject(), 'src/a.ts');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('findings for the edited file come back as blocking feedback with fix commands', () => {
  const result = runHook(makeProject(FAKE_WITH_FINDINGS), 'src/a.ts');
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /#abc123 array-repeated-find at src[\\/]a\.ts:3/);
  assert.match(output.reason, /loadwise perf --fix --only abc123/);
  assert.doesNotMatch(output.reason, /zzz/);
});

test('a clean file produces no output', () => {
  const result = runHook(makeProject('console.log(JSON.stringify({ findings: [] }));'), 'src/a.ts');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a hung loadwise is cut off by the timeout and the hook still exits 0', () => {
  const result = runHook(makeProject('setInterval(() => {}, 1000);'), 'src/a.ts', {
    LOADWISE_HOOK_TIMEOUT_MS: '500',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a crashing loadwise and invalid stdin both exit 0 silently', () => {
  const crashed = runHook(makeProject('throw new Error("boom");'), 'src/a.ts');
  assert.equal(crashed.status, 0);
  assert.equal(crashed.stdout, '');
  const garbage = spawnSync(process.execPath, [hookScript], { input: 'not json', encoding: 'utf8' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});
