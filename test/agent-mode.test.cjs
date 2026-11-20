'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { assignFindingIds } = require('../lib/finding-ids.cjs');

const bin = path.resolve(__dirname, '../bin/maintainability-check.cjs');
// Deep control flow with an else after a return, which has a fix.
const source = [
  'function label(values, mode) {',
  '  if (!values.length) {',
  '    return "none";',
  '  } else {',
  '    let text = "";',
  '    for (const value of values) {',
  '      if (mode === "loud") {',
  '        text += "?";',
  '        if (value > 0) text += "!";',
  '      }',
  '      text += ".";',
  '    }',
  '    return text;',
  '  }',
  '}',
  'module.exports = { label };',
].join('\n');

function tempRoot(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'maintainability-agent-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function project(context, text = source) {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'pick.js'), text);
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
  const scan = (...extra) => JSON.parse(run('.', '--json', '--include-contextual', ...extra).stdout).findings;
  return { root, run, scan };
}

test('ids survive a line inserted above the finding and findings carry fixable', (context) => {
  const { root, scan } = project(context);
  const before = scan();
  assert.ok(before.length > 0);
  fs.writeFileSync(path.join(root, 'pick.js'), '// a new comment\n' + source);
  const after = scan();
  assert.deepEqual(
    after.map(({ id }) => id),
    before.map(({ id }) => id),
  );
  for (const finding of before) {
    assert.match(finding.id, /^[0-9a-f]{12}$/);
    assert.equal(finding.fixable, Boolean(finding.fix));
  }
});

test('identical findings on identical lines get numbered suffixes in order', (context) => {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'same.js'), 'call();\ncall();\ncall();\n');
  const findings = [1, 2, 3].map((line) => ({ file: 'same.js', line, ruleId: 'some-rule' }));
  const [first, second, third] = assignFindingIds(findings, root).map(({ id }) => id);
  assert.equal(second, first + '-2');
  assert.equal(third, first + '-3');
});

test('--fix --only applies one fix without a terminal; unknown ids exit 2', (context) => {
  const { run, scan } = project(context);
  const chosen = scan().find((finding) => finding.fix);
  assert.ok(chosen, 'the example has a fixable finding');
  const result = run('.', '--fix', '--only', chosen.id, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { applied: [chosen.id], alreadyApplied: [], failed: [] });
  assert.ok(!scan().some((finding) => finding.id === chosen.id));
  const unknown = run('.', '--fix', '--only', '000000000000', '--json');
  assert.equal(unknown.status, 2);
  assert.deepEqual(JSON.parse(unknown.stdout).failed, [{ id: '000000000000', reason: 'unknown id' }]);
});

test('a maintainability-reviewed comment makes a finding contextual, but not inside a string', (context) => {
  const { root, scan } = project(context);
  const [finding] = scan();
  const lines = source.split('\n');
  const marker = (ruleId) => `// maintainability-reviewed ${ruleId} -- intended: two outcomes only`;
  lines.splice(finding.line - 1, 0, marker(finding.ruleId));
  fs.writeFileSync(path.join(root, 'pick.js'), lines.join('\n'));
  const [reviewed] = scan();
  assert.equal(reviewed.contextualReason, 'Reviewed in source: intended: two outcomes only');
  const quoted = source.split('\n');
  quoted.splice(finding.line - 1, 0, 'const text = `', marker(finding.ruleId), '`;');
  fs.writeFileSync(path.join(root, 'pick.js'), quoted.join('\n'));
  assert.ok(scan().every((row) => !String(row.contextualReason).startsWith('Reviewed in source')));
});

function initAgent(root, ...args) {
  return spawnSync(process.execPath, [bin, 'agent', 'init', ...args], { cwd: root, encoding: 'utf8' });
}

test('agent init is idempotent, keeps other text and shares AGENTS.md with another tool block', (context) => {
  const root = tempRoot(context);
  const agentsFile = path.join(root, 'AGENTS.md');
  fs.writeFileSync(
    agentsFile,
    '# Team rules\n\n<!-- backend-perf-check:agent:start -->\nperf\n<!-- backend-perf-check:agent:end -->\n',
  );
  assert.equal(initAgent(root).status, 0);
  assert.equal(initAgent(root, '--mode', 'auto').status, 0);
  const text = fs.readFileSync(agentsFile, 'utf8');
  assert.ok(text.startsWith('# Team rules\n\n<!-- backend-perf-check:agent:start -->\nperf\n'));
  assert.equal(text.match(/maintainability-check:agent:start/g).length, 1);
  assert.match(text, /Mode: auto/);
  assert.match(initAgent(root, '--mode', 'auto').stdout, /already up to date/);
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
