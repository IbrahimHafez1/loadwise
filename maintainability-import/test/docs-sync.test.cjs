'use strict';

// Fails when README.md, `--help`, the rule registry or package.json `files` drift apart.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { examples } = require('../lib/examples.cjs');

// examples.cjs holds one entry per rule id, so its keys are the rule registry.
const knownRules = new Set(Object.keys(examples));

const root = path.join(__dirname, '..');
const binEntry = path.join(root, 'bin', 'warden-maint.cjs');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const helpText = spawnSync(process.execPath, [binEntry, '--help'], { encoding: 'utf8' }).stdout;

// Package names are hyphenated too but are not rules.
const siblingPackages = new Set(['warden-backend', 'warden-maint']);
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

test('every registry rule is documented in the README', () => {
  const documented = readRuleTokens(readme);
  const missing = [...knownRules].filter((rule) => !documented.has(rule));
  assert.deepEqual(missing, [], `rules missing from the README: ${missing.join(', ')}`);
});

test('every rule-like README entry exists in the code', () => {
  const codeText = sourceFiles(path.join(root, 'lib'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const stale = [...readRuleTokens(readme)].filter(
    (token) => !siblingPackages.has(token) && !knownRules.has(token) && !codeText.includes(`'${token}'`),
  );
  assert.deepEqual(stale, [], `README rule entries with no matching rule: ${stale.join(', ')}`);
});

test('every --help flag and subcommand is in the README', () => {
  const flags = new Set(helpText.match(/--[a-z][a-z-]*/g));
  const subcommands = [...helpText.matchAll(/^ {2}warden-maint (agent [a-z]+)/gm)].map((match) => match[1]);
  assert.ok(flags.size >= 8 && subcommands.length >= 1, 'could not parse --help');
  const missing = [...flags, ...subcommands].filter((name) => !readme.includes(name));
  assert.deepEqual(missing, [], `README does not mention: ${missing.join(', ')}`);
});

function runtimeRequires(entryFile, seen = new Set()) {
  if (seen.has(entryFile)) return seen;
  seen.add(entryFile);
  const source = fs.readFileSync(entryFile, 'utf8');
  const relativeLiterals = [...source.matchAll(/['"](\.{1,2}\/[\w./-]+)['"]/g)].map((match) => match[1]);
  for (const literal of relativeLiterals) {
    const target = [literal, `${literal}.cjs`, `${literal}/index.cjs`]
      .map((candidate) => path.resolve(path.dirname(entryFile), candidate))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (target?.endsWith('.cjs')) runtimeRequires(target, seen);
    else if (target) seen.add(target);
  }
  return seen;
}

test('package.json files covers every runtime require reachable from bin/', () => {
  const entries = fs.readdirSync(path.join(root, 'bin')).map((name) => path.join(root, 'bin', name));
  const reachable = entries.flatMap((entry) => [...runtimeRequires(entry)]);
  const patterns = packageJson.files.map((entry) => entry.replace(/\/$/, ''));
  const uncovered = reachable
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter(
      (file) =>
        file !== 'package.json' && !patterns.some((pattern) => file === pattern || file.startsWith(`${pattern}/`)),
    );
  assert.deepEqual(uncovered, [], `not shipped by package.json files: ${uncovered.join(', ')}`);
});
