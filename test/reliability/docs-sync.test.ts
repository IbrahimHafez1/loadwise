// Fails when the README's reliability section, `loadwise rel --help` or the rule registry drift
// apart.
import { readRuleTokens } from '../shared/read-rule-tokens.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { impactByRule } from '../../lib/reliability/rule-ids.js';
import { pillarOfRule } from '../../lib/shared/rule-registry.js';

const root = path.join(import.meta.dirname, '..', '..');
const binEntry = path.join(root, 'bin', 'loadwise.js');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
// Rule tokens are compared within this checker's part of the README; flags against all of it.
const section = readme.slice(
  readme.indexOf('\n# Reliability checker\n'),
  readme.indexOf('\n# Maintainability checker\n'),
);
const helpText = spawnSync(process.execPath, [binEntry, 'rel', '--help'], { encoding: 'utf8' }).stdout;
// Every id a reliability finding can carry: source, migration, contract and polyglot rules.
const reliabilityRules = new Set(Object.keys(impactByRule));

test('the README has a reliability section between performance and maintainability', () => {
  assert.ok(section.length > 1000, 'missing "# Reliability checker" before "# Maintainability checker"');
  assert.ok(readme.indexOf('\n# Performance checker\n') < readme.indexOf('\n# Reliability checker\n'));
});

test('every reliability rule is documented in the reliability section', () => {
  const documented = readRuleTokens(section);
  const missing = [...reliabilityRules].filter((rule) => !documented.has(rule));
  assert.deepEqual(missing, [], `rules missing from the README: ${missing.join(', ')}`);
});

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

// Package names such as `p-limit` look like rule ids; they pass when the checker's code names them.
test('every rule-like entry in the reliability section is a reliability rule or a name the checks use', () => {
  const codeText = [
    ...sourceFiles(path.join(root, 'lib', 'performance')),
    ...sourceFiles(path.join(root, 'lib', 'reliability')),
  ]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const foreign = [...readRuleTokens(section)].filter(
    (token) => !reliabilityRules.has(token) && (pillarOfRule(token) !== undefined || !codeText.includes(`'${token}'`)),
  );
  assert.deepEqual(foreign, [], `README entries that are not reliability rules: ${foreign.join(', ')}`);
});

test('every rel --help flag and subcommand is in the README', () => {
  const flags = new Set(helpText.match(/--[a-z][a-z-]*/g));
  const subcommands = new Set(
    [...helpText.matchAll(/^ {2}loadwise rel ([a-z]+)/gm)].map((match) => `loadwise rel ${match[1]}`),
  );
  assert.ok(flags.size > 10 && subcommands.size >= 3, 'could not parse --help');
  const missing = [...flags, ...subcommands].filter((name) => !readme.includes(name));
  assert.deepEqual(missing, [], `README does not mention: ${missing.join(', ')}`);
});
