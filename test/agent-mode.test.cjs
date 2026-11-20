'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { assignFindingIds } = require('../lib/finding-ids.cjs');

const bin = path.resolve(__dirname, '../bin/backend-perf-check.cjs');
const example = fs.readFileSync(path.resolve(__dirname, '../examples/slow.ts'), 'utf8');

function tempRoot(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-agent-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A package.json makes this folder the project root that ids are relative to.
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function project(context) {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'slow.ts'), example);
  const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
  const scan = () => JSON.parse(run(['slow.ts', '--json', '--engine', 'js']).stdout).findings;
  return { root, run, scan };
}

test('ids survive a line inserted above the finding', (context) => {
  const { root, scan } = project(context);
  const before = scan();
  fs.writeFileSync(path.join(root, 'slow.ts'), '// a new comment\n' + example);
  const after = scan();
  assert.equal(after.length, before.length);
  assert.notEqual(after[0].line, before[0].line);
  assert.deepEqual(
    after.map(({ id }) => id),
    before.map(({ id }) => id),
  );
  for (const { id } of before) assert.match(id, /^[0-9a-f]{12}$/);
});

test('identical findings on identical lines get numbered suffixes in order', (context) => {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'same.ts'), 'call();\ncall();\ncall();\n');
  const findings = [1, 2, 3].map((line) => ({ file: path.join(root, 'same.ts'), line, ruleId: 'some-rule' }));
  const [first, second, third] = assignFindingIds(findings, root).map(({ id }) => id);
  assert.equal(second, first + '-2');
  assert.equal(third, first + '-3');
  const [table] = assignFindingIds([{ ruleId: 'some-rule', target: 'public.orders' }], root);
  assert.match(table.id, /^[0-9a-f]{12}$/);
});

test('JSON findings carry the fix and whether they are fixable', (context) => {
  const { scan } = project(context);
  for (const finding of scan()) {
    assert.equal(finding.fixable, true);
    assert.ok(finding.fix.changes[0].after);
  }
});

test('--fix --only applies just the listed fix without a terminal', (context) => {
  const { run, scan } = project(context);
  const [chosen, ...others] = scan();
  const result = run(['slow.ts', '--fix', '--only', chosen.id, '--json', '--engine', 'js']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { applied: [chosen.id], failed: [] });
  assert.deepEqual(
    scan().map(({ id }) => id),
    others.map(({ id }) => id),
  );
});

test('--fix --only reports an unknown id and exits 2', (context) => {
  const { run, scan } = project(context);
  const [chosen] = scan();
  const result = run(['slow.ts', '--fix', '--only', `${chosen.id},000000000000`, '--json', '--engine', 'js']);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    applied: [chosen.id],
    failed: [{ id: '000000000000', reason: 'unknown id' }],
  });
});

function initAgent(root, ...args) {
  return spawnSync(process.execPath, [bin, 'agent', 'init', ...args], { cwd: root, encoding: 'utf8' });
}

test('agent init replaces its own block and keeps the other text', (context) => {
  const root = tempRoot(context);
  const agentsFile = path.join(root, 'AGENTS.md');
  fs.writeFileSync(agentsFile, '# Team rules\n\nKeep functions small.\n');
  assert.equal(initAgent(root).status, 0);
  assert.equal(initAgent(root, '--mode', 'auto').status, 0);
  const text = fs.readFileSync(agentsFile, 'utf8');
  assert.ok(text.startsWith('# Team rules\n\nKeep functions small.\n'));
  assert.equal(text.match(/backend-perf-check:agent:start/g).length, 1);
  assert.match(text, /Mode: auto/);
  assert.doesNotMatch(text, /Mode: ask/);
  fs.appendFileSync(agentsFile, '\nAfter the block.\n');
  const unchanged = initAgent(root, '--mode', 'auto');
  assert.match(unchanged.stdout, /already up to date/);
  assert.match(fs.readFileSync(agentsFile, 'utf8'), /After the block\.\n$/);
  assert.equal(initAgent(root, '--mode', 'sometimes').status, 2);
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
