import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { assignFindingIds } from '../../lib/maintainability/finding-ids.js';
import { applyReviewDirectives } from '../../lib/maintainability/review-directive.js';
import type { TestContext } from 'node:test';
import { parseReport } from '../types/cli-report.js';
import type { Finding } from '../../lib/shared/types.js';
import { applyFixes, applyChosenFixes } from '../../lib/maintainability/fix-cli.js';
import { printChangedFindings } from '../../lib/maintainability/changed-output.js';
const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
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

function tempRoot(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'maintainability-agent-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function project(context: TestContext, text = source) {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'pick.js'), text);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bin, 'maint', ...args], { cwd: root, encoding: 'utf8' });
  const scan = (...extra: string[]) =>
    parseReport(run('.', '--json', '--include-contextual', ...extra).stdout).findings;
  return { root, run, scan };
}

test('automatic mode and changed-lines bulk guidance reserve a reviewed fix for individual application', async (context) => {
  const root = tempRoot(context);
  const file = 'work.js';
  const filename = path.join(root, file);
  fs.writeFileSync(filename, 'original();\n');
  const finding = {
    id: 'reviewed',
    ruleId: 'deep-control-flow',
    message: 'reviewed fix',
    file,
    line: 1,
    fix: { requiresReview: true, changes: [{ file, line: 1, before: 'original();', after: 'reviewed();' }] },
  };
  const log = context.mock.method(console, 'log', () => {});
  printChangedFindings([finding, { ...finding, id: 'other' }], 'npx loadwise maint');
  const output = log.mock.calls.map((call) => call.arguments[0]).join('\n');
  assert.match(output, /--fix --only reviewed/);
  assert.doesNotMatch(output, /^Fix all:/m);
  assert.equal(await applyFixes([finding], root, { all: true }), 0);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'original();\n');
  assert.equal(applyChosenFixes([finding], [finding.id], root, { json: true }), 0);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'reviewed();\n');
});

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
    assert.match(String(finding.id), /^[0-9a-f]{12}$/);
    assert.equal(finding.fixable, Boolean(finding.fix));
  }
});

test('identical findings on identical lines get numbered suffixes in order', (context) => {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'same.js'), 'call();\ncall();\ncall();\n');
  const findings = [1, 2, 3].map((line) => ({ file: 'same.js', line, ruleId: 'some-rule', message: 'some message' }));
  const [first, second, third] = assignFindingIds(findings, root).map(({ id }) => id);
  assert.equal(second, first + '-2');
  assert.equal(third, first + '-3');
});

test('--fix --only applies one fix without a terminal; unknown ids exit 2', (context) => {
  const { run, scan } = project(context);
  const chosen = scan().find((finding: Finding) => finding.fix);
  assert.ok(chosen, 'the example has a fixable finding');
  assert.ok(chosen.id);
  const result = run('.', '--fix', '--only', chosen.id, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { applied: [chosen.id], alreadyApplied: [], failed: [] });
  assert.ok(!scan().some((finding: Finding) => finding.id === chosen.id));
  const unknown = run('.', '--fix', '--only', '000000000000', '--json');
  assert.equal(unknown.status, 2);
  assert.deepEqual(JSON.parse(unknown.stdout).failed, [{ id: '000000000000', reason: 'unknown id' }]);
});

test('a loadwise-reviewed comment makes a finding contextual, but not inside a string', (context) => {
  const { root, scan } = project(context);
  const [finding] = scan();
  assert.ok(finding?.line);
  const lines = source.split('\n');
  const marker = (ruleId: string) => `// loadwise-reviewed ${ruleId} -- intended: two outcomes only`;
  lines.splice(finding.line - 1, 0, marker(finding.ruleId));
  fs.writeFileSync(path.join(root, 'pick.js'), lines.join('\n'));
  const [reviewed] = scan();
  assert.equal(reviewed.contextualReason, 'Reviewed in source: intended: two outcomes only');
  const quoted = source.split('\n');
  quoted.splice(finding.line - 1, 0, 'const text = `', marker(finding.ruleId), '`;');
  fs.writeFileSync(path.join(root, 'pick.js'), quoted.join('\n'));
  assert.ok(scan().every((row) => !String(row.contextualReason).startsWith('Reviewed in source')));
});

test('a finding about a whole file is dismissed by a reviewed comment on line 1', (context) => {
  const root = tempRoot(context);
  const reason = 'one cohesive table of rules';
  fs.writeFileSync(path.join(root, 'a.js'), `// loadwise-reviewed large-module -- ${reason}\nconst value = 1;\n`);
  fs.writeFileSync(path.join(root, 'b.js'), 'const value = 1;\n');
  const findings: Finding[] = [
    { ruleId: 'large-module', message: 'long', file: 'a.js', line: 1 },
    { ruleId: 'large-module', message: 'long', file: 'b.js', line: 1 },
    { ruleId: 'high-branch-complexity', message: 'branches', file: 'a.js', line: 1 },
  ];
  applyReviewDirectives(findings, root);
  assert.equal(findings[0].contextualReason, 'Reviewed in source: ' + reason);
  assert.equal(findings[1].contextualReason, undefined);
  assert.equal(findings[2].contextualReason, undefined);
});

test('contract rules stay non-dismissable by a review comment', (context) => {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'a.js'), '// loadwise-reviewed file-placement -- nope\nconst value = 1;\n');
  const findings: Finding[] = [{ ruleId: 'file-placement', message: 'placement', file: 'a.js', line: 2 }];
  applyReviewDirectives(findings, root);
  assert.equal(findings[0].contextualReason, undefined);
});
