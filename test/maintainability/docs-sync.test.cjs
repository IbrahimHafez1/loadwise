'use strict';

// Fails when the README's maintainability section, `loadwise maint --help` or the rule registry drift apart.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { examples } = require('../../lib/maintainability/examples.cjs');

// examples.cjs holds one entry per rule id, so its keys are the rule registry.
const knownRules = new Set(Object.keys(examples));

const root = path.join(__dirname, '..', '..');
const binEntry = path.join(root, 'bin', 'loadwise.cjs');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
// Rule tokens are compared within this checker's part of the README; commands and flags against all of it.
const section = readme.slice(
  readme.indexOf('\n# Maintainability checker\n'),
  readme.indexOf('\n## Developing locally\n'),
);
const helpText = spawnSync(process.execPath, [binEntry, 'maint', '--help'], { encoding: 'utf8' }).stdout;

const rulePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

function readRuleTokens(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  const tokens = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return new Set(tokens.filter((token) => rulePattern.test(token)));
}

function sourceFiles(directory) {
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
    .map((file) => fs.readFileSync(file, 'utf8'))
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
