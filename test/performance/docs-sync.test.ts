// Fails when the README's performance section, `loadwise perf --help` or the rule registry drift
// apart.
import { readRuleTokens } from '../shared/read-rule-tokens.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { knownRules } from '../../lib/performance/rule-ids.js';

const root = path.join(import.meta.dirname, '..', '..');
const binEntry = path.join(root, 'bin', 'loadwise.js');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
// Rule tokens are compared within this checker's part of the README; commands and flags against all
// of it.
const section = readme.slice(readme.indexOf('\n# Performance checker\n'), readme.indexOf('\n# Reliability checker\n'));
const helpText = spawnSync(process.execPath, [binEntry, 'perf', '--help'], { encoding: 'utf8' }).stdout;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.name === 'vendor' || entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(ts|ya?ml)$/.test(entry.name) ? [fullPath] : [];
  });
}

test('the README has a performance section', () => {
  assert.ok(section.length > 1000, 'missing "# Performance checker" before "# Reliability checker"');
});

test('every registry rule is documented in the README', () => {
  const documented = readRuleTokens(section);
  const missing = [...knownRules].filter((rule) => !documented.has(rule));
  assert.deepEqual(missing, [], `rules missing from the README: ${missing.join(', ')}`);
});

test('every rule-like README entry exists in the code', () => {
  const codeText = [
    ...sourceFiles(path.join(root, 'lib', 'performance')),
    ...sourceFiles(path.join(root, 'polyglot', 'performance')),
  ]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const stale = [...readRuleTokens(section)].filter(
    (token) => !knownRules.has(token) && !codeText.includes(`'${token}'`) && !codeText.includes(`id: ${token}`),
  );
  assert.deepEqual(stale, [], `README rule entries with no matching rule: ${stale.join(', ')}`);
});

test('every --help flag and subcommand is in the README', () => {
  const flags = new Set(helpText.match(/--[a-z][a-z-]*/g));
  const subcommands = new Set(
    [...helpText.matchAll(/^ {2}loadwise perf ([a-z]+)(?: ([a-z]+))?/gm)]
      .filter((match) => !/^[[<-]/.test(match[1]))
      .map((match) => (match[1] === 'agent' ? `${match[1]} ${match[2]}` : match[1])),
  );
  assert.ok(flags.size > 10 && subcommands.size >= 5, 'could not parse --help');
  const missing = [...flags, ...subcommands].filter((name) => !readme.includes(name));
  assert.deepEqual(missing, [], `README does not mention: ${missing.join(', ')}`);
});

test('README sample output for examples/slow.ts matches the CLI', () => {
  const sample = section.split('```text\n')[1].split('\n')[0];
  const run = spawnSync(process.execPath, [binEntry, 'perf', 'examples/slow.ts'], { cwd: root, encoding: 'utf8' });
  assert.ok(run.stdout.includes(sample), `CLI output no longer contains the README sample line:\n${sample}`);
});
