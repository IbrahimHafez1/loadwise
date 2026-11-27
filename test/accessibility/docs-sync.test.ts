// Fails when the README's accessibility section, `loadwise a11y --help` or the rule registry drift apart.
import { readRuleTokens } from '../shared/read-rule-tokens.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { impactByRule } from '../../lib/accessibility/rule-ids.js';

const root = path.join(import.meta.dirname, '..', '..');
const binEntry = path.join(root, 'bin', 'loadwise.js');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
// Rule tokens are compared within this checker's part of the README; flags against all of it.
const section = readme.slice(
  readme.indexOf('\n# Accessibility checker\n'),
  readme.indexOf('\n## Developing locally\n'),
);
const helpText = spawnSync(process.execPath, [binEntry, 'a11y', '--help'], { encoding: 'utf8' }).stdout;
const accessibilityRules = new Set(Object.keys(impactByRule));

test('the README has an accessibility section after the security section', () => {
  assert.ok(section.length > 1000, 'missing "# Accessibility checker" before "## Developing locally"');
  assert.ok(readme.indexOf('\n# Security checker\n') < readme.indexOf('\n# Accessibility checker\n'));
});

test('every accessibility rule is documented once in the accessibility section', () => {
  const documented = readRuleTokens(section);
  const missing = [...accessibilityRules].filter((rule) => !documented.has(rule));
  assert.deepEqual(missing, [], `rules missing from the README: ${missing.join(', ')}`);
  const anchorless = [...accessibilityRules].filter((rule) => section.split(`<a id="${rule}"></a>`).length !== 2);
  assert.deepEqual(anchorless, [], `rules without exactly one README anchor: ${anchorless.join(', ')}`);
});

test('every rule-like entry in the accessibility section is an accessibility rule', () => {
  const foreign = [...readRuleTokens(section)].filter((token) => !accessibilityRules.has(token));
  assert.deepEqual(foreign, [], `README entries that are not accessibility rules: ${foreign.join(', ')}`);
});

test('every a11y --help flag is in the README', () => {
  const flags = new Set(helpText.match(/--[a-z][a-z-]*/g));
  assert.ok(flags.size > 10, 'could not parse --help');
  const missing = [...flags].filter((name) => !readme.includes(name));
  assert.deepEqual(missing, [], `README does not mention: ${missing.join(', ')}`);
});
