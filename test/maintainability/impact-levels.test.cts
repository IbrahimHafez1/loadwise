import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { impactByRule, knownRules } from '../../lib/maintainability/rule-ids.cjs';
import { impactLevels } from '../../lib/shared/impact-levels.cjs';
import type { TestContext } from 'node:test';
import { parseReport } from '../types/cli-report.cjs';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
// syntax-error reports a file the parser rejected; it is not a rule a config can switch off.
const maintainabilityRules = [...knownRules, 'syntax-error'];

test('every maintainability rule id has a valid impact level and none is invented', () => {
  assert.deepEqual(Object.keys(impactByRule).sort(), [...maintainabilityRules].sort());
  assert.deepEqual(
    maintainabilityRules.filter((rule) => !impactLevels.includes(impactByRule[rule])),
    [],
  );
});

test('the README lists the impact level of every maintainability rule', () => {
  const readme = fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8');
  const wrong = Object.entries(impactByRule).filter(
    ([rule, level]) => !new RegExp(['\\|\\s*`', rule, '`\\s*\\|\\s*', level, '\\s*\\|'].join('')).test(readme),
  );
  assert.deepEqual(wrong, []);
});

function project(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'maintainability-impact-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // The low finding comes first in the file, so sorting must move the medium one above it.
  fs.writeFileSync(
    path.join(directory, 'app.js'),
    [
      'function nested(items) {',
      '  for (const a of items) {',
      '    if (a) {',
      '      for (const b of a) {',
      '        if (b) {',
      '          console.log(b);',
      '        }',
      '      }',
      '    }',
      '  }',
      '}',
      'function dispatch(value) {',
      ...Array.from({ length: 16 }, (_, index) => `  if (value === ${index}) return ${index};`),
      '}',
    ].join('\n'),
  );
  return (...args: string[]) =>
    spawnSync(process.execPath, [bin, 'maint', ...args], { cwd: directory, encoding: 'utf8' });
}

test('JSON findings carry impactLevel and text output shows it, most severe first', (context) => {
  const run = project(context);
  const json = parseReport(run('--json').stdout);
  assert.deepEqual(
    json.findings.map(({ ruleId, impactLevel }) => [ruleId, impactLevel]),
    [
      ['high-branch-complexity', 'medium'],
      ['deep-control-flow', 'low'],
    ],
  );
  const lines = run('--fail-on', 'all').stdout.split('\n');
  assert.match(lines[0], /\[high-branch-complexity #[0-9a-f]+\] medium: /);
});

test('--min-impact filters findings and the exit code; an invalid level exits 2', (context) => {
  const run = project(context);
  assert.equal(run('--fail-on', 'all').status, 1);
  const medium = run('--fail-on', 'all', '--min-impact', 'medium', '--json');
  assert.equal(medium.status, 1);
  assert.deepEqual(
    parseReport(medium.stdout).findings.map(({ ruleId }) => ruleId),
    ['high-branch-complexity'],
  );
  assert.equal(run('--fail-on', 'all', '--min-impact', 'high').status, 0);
  assert.equal(run('--min-impact', 'severe').status, 2);
});
