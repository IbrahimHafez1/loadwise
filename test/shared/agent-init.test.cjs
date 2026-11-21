'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
require('./history-test-state.cjs').isolateHistory();

function tempRoot(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-agent-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function initAgent(root, ...args) {
  return spawnSync(process.execPath, [bin, 'agent', 'init', ...args], { cwd: root, encoding: 'utf8' });
}

function legacyBlock(name, body) {
  return `<!-- ${name}:agent:start -->\n${body}\n<!-- ${name}:agent:end -->`;
}

test('MCP configuration pins the executable and project even when the client starts elsewhere', (context) => {
  const root = tempRoot(context);
  const project = path.join(root, 'project with spaces');
  fs.mkdirSync(project);
  const run = (...args) => spawnSync(process.execPath, [bin, 'agent', 'mcp', ...args], { cwd: root, encoding: 'utf8' });
  const result = run('project with spaces', '--print-config');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    type: 'stdio',
    command: process.execPath,
    args: [bin, 'agent', 'mcp', project],
  });
  for (const args of [['missing'], ['.', '.'], ['--unknown']]) {
    const invalid = run(...args);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, '');
  }
});

test('agent init writes one block covering all three checkers', (context) => {
  const root = tempRoot(context);
  assert.equal(initAgent(root).status, 0);
  const text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal(text.match(/<!-- loadwise:agent:start -->/g).length, 1);
  assert.match(text, /npx loadwise check --json/);
  assert.match(text, /npx loadwise perf --fix --only <id>/);
  assert.match(text, /npx loadwise maint --fix --only <id>/);
  assert.match(text, /npx loadwise sec --fix --only <id>/);
  assert.match(text, /\/\/ loadwise-reviewed <rule-id> -- <specific reason>/);
  assert.match(text, /check, audit, preview or handoff-only request, report the results without editing/);
  assert.match(text, /explicit request to fix findings already authorizes work/);
  assert.doesNotMatch(text, /warden/);
});

test('agent init replaces its own block and keeps the other text', (context) => {
  const root = tempRoot(context);
  const agentsFile = path.join(root, 'AGENTS.md');
  fs.writeFileSync(agentsFile, '# Team rules\n\nKeep functions small.\n');
  assert.equal(initAgent(root).status, 0);
  assert.equal(initAgent(root, '--mode', 'auto').status, 0);
  const text = fs.readFileSync(agentsFile, 'utf8');
  assert.ok(text.startsWith('# Team rules\n\nKeep functions small.\n'));
  assert.equal(text.match(/loadwise:agent:start/g).length, 1);
  assert.match(text, /Mode: auto/);
  assert.match(text, /fix\.requiresReview.*approval for that individual fix/);
  assert.doesNotMatch(text, /Mode: ask/);
  fs.appendFileSync(agentsFile, '\nAfter the block.\n');
  assert.match(initAgent(root, '--mode', 'auto').stdout, /already up to date/);
  assert.match(fs.readFileSync(agentsFile, 'utf8'), /After the block\.\n$/);
  assert.equal(initAgent(root, '--mode', 'sometimes').status, 2);
});

test('ask and auto instructions assess all findings and verify actual changes within scope', (context) => {
  const root = tempRoot(context);
  for (const mode of ['ask', 'auto']) {
    assert.equal(initAgent(root, '--mode', mode).status, 0);
    const text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(text, /start with a read-only `npx loadwise check --json`/);
    assert.match(text, /Whenever you run Loadwise, automatically review every finding/);
    assert.match(text, /loadwise agent history/);
    assert.match(text, /loadwise agent verify --outcomes/);
    assert.match(text, /Evaluate both generated and manual findings against the actual code, callers and tests/);
    assert.match(text, /A unified `check --config <file>` maps to `--loadwise-config <file>`/);
    assert.match(text, /Performance and security use the ids from that filtered scan without those change flags/);
    assert.match(text, /explicitly requests `loadwise fix --yes` or `loadwise fix --all`/);
    assert.match(text, /before\/after hunks and per-finding outcomes with `--json`/);
    assert.match(text, /command the user already ran, review every actual applied hunk/);
    assert.match(text, /even when zero manual findings remain/);
    assert.match(text, /Run the applicable tests or typecheck, then repeat the scoped check/);
  }
});

test('agent init imports AGENTS.md from CLAUDE.md exactly once', (context) => {
  const root = tempRoot(context);
  const claudeFile = path.join(root, 'CLAUDE.md');
  initAgent(root);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), '@AGENTS.md\n');
  fs.writeFileSync(claudeFile, '# Project notes\n');
  initAgent(root);
  initAgent(root);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), '# Project notes\n\n@AGENTS.md\n');
});

test('the codewarden-era perf and maint blocks become one loadwise block in place', (context) => {
  const root = tempRoot(context);
  const agentsFile = path.join(root, 'AGENTS.md');
  fs.writeFileSync(
    agentsFile,
    `# Team rules\n\n${legacyBlock('warden-backend', 'perf text')}\n\nBetween.\n\n${legacyBlock('warden-maint', 'maint text')}\n\nafter\n`,
  );
  assert.equal(initAgent(root).status, 0);
  const text = fs.readFileSync(agentsFile, 'utf8');
  assert.ok(text.startsWith('# Team rules\n\n<!-- loadwise:agent:start -->'));
  assert.ok(text.endsWith('<!-- loadwise:agent:end -->\n\nBetween.\n\nafter\n'));
  assert.equal(text.match(/agent:start/g).length, 1);
  assert.doesNotMatch(text, /warden|perf text|maint text/);
});

test('blocks written under the oldest names are upgraded too', (context) => {
  for (const name of ['backend-perf-check', 'maintainability-check']) {
    const root = tempRoot(context);
    const agentsFile = path.join(root, 'AGENTS.md');
    fs.writeFileSync(agentsFile, `# Team rules\n\n${legacyBlock(name, 'old text')}\n`);
    assert.equal(initAgent(root).status, 0);
    const text = fs.readFileSync(agentsFile, 'utf8');
    assert.ok(text.startsWith('# Team rules\n\n<!-- loadwise:agent:start -->'));
    assert.ok(text.endsWith('<!-- loadwise:agent:end -->\n'));
    assert.doesNotMatch(text, new RegExp(name + '|old text'));
  }
});

test('perf agent init and maint agent init write the same single block', (context) => {
  const root = tempRoot(context);
  for (const checker of ['perf', 'maint']) {
    const result = spawnSync(process.execPath, [bin, checker, 'agent', 'init'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal(text.match(/agent:start/g).length, 1);
});
