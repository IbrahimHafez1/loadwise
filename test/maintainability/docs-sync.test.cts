// Fails when the README's maintainability section, `loadwise maint --help` or the rule registry
// drift apart.
import { readRuleTokens } from '../shared/read-rule-tokens.cjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { examples } from '../../lib/maintainability/examples.cjs';

// examples.cjs holds one entry per rule id, so its keys are the rule registry.
const knownRules = new Set(Object.keys(examples));

const root = path.join(__dirname, '..', '..');
const binEntry = path.join(root, 'bin', 'loadwise.cjs');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
// Rule tokens are compared within this checker's part of the README; commands and flags against all
// of it.
const section = readme.slice(readme.indexOf('\n# Maintainability checker\n'), readme.indexOf('\n# Security checker\n'));
const helpText = spawnSync(process.execPath, [binEntry, 'maint', '--help'], { encoding: 'utf8' }).stdout;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.name === 'vendor' || entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(cjs|ya?ml)$/.test(entry.name) ? [fullPath] : [];
  });
}

test('the README has a maintainability section', () => {
  assert.ok(section.length > 1000, 'missing "# Maintainability checker" before "## Developing locally"');
});

test('every registry rule is documented in the README', () => {
  const documented = readRuleTokens(section);
  const missing = [...knownRules].filter((rule) => !documented.has(rule));
  assert.deepEqual(missing, [], `rules missing from the README: ${missing.join(', ')}`);
});

test('every rule-like README entry exists in the code', () => {
  const codeText = sourceFiles(path.join(root, 'lib', 'maintainability'))
    .map((file: string) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const stale = [...readRuleTokens(section)].filter(
    (token) => !knownRules.has(token) && !codeText.includes(`'${token}'`),
  );
  assert.deepEqual(stale, [], `README rule entries with no matching rule: ${stale.join(', ')}`);
});

test('every --help flag and subcommand is in the README', () => {
  const flags = new Set(helpText.match(/--[a-z][a-z-]*/g));
  const subcommands = [...helpText.matchAll(/^ {2}loadwise maint (agent [a-z]+)/gm)].map((match) => match[1]);
  assert.ok(flags.size >= 8 && subcommands.length >= 1, 'could not parse --help');
  const missing = [...flags, ...subcommands].filter((name) => !readme.includes(name));
  assert.deepEqual(missing, [], `README does not mention: ${missing.join(', ')}`);
});
