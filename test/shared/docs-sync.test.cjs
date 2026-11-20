'use strict';

// Fails when README.md, `loadwise --help` or package.json `files` drift apart.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..');
const binEntry = path.join(root, 'bin', 'loadwise.cjs');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const helpText = spawnSync(process.execPath, [binEntry, '--help'], { encoding: 'utf8' }).stdout;

test('every loadwise --help flag and command is in the README', () => {
  const flags = new Set(helpText.match(/--[a-z][a-z-]*/g));
  const commands = new Set([...helpText.matchAll(/^ {2}(loadwise(?: [a-z]+)+)/gm)].map((match) => match[1]));
  assert.ok(flags.size >= 8 && commands.size >= 4, 'could not parse --help');
  const missing = [...flags, ...commands].filter((name) => !readme.includes(name));
  assert.deepEqual(missing, [], `README does not mention: ${missing.join(', ')}`);
});

test('the README names no retired command or package', () => {
  const retired = readme.match(/warden-backend|warden-maint|@codewarden|codewarden/gi) ?? [];
  assert.deepEqual(retired, []);
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
  assert.ok(
    reachable.some((file) => file.includes(path.join('lib', 'maintainability'))),
    'bin reaches both checkers',
  );
  const patterns = packageJson.files.map((entry) => entry.replace(/\/$/, ''));
  const uncovered = reachable
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter(
      (file) =>
        file !== 'package.json' && !patterns.some((pattern) => file === pattern || file.startsWith(`${pattern}/`)),
    );
  assert.deepEqual(uncovered, [], `not shipped by package.json files: ${uncovered.join(', ')}`);
});

// SARIF helpUri points at README#<rule-id>. syntax-error stops the scan instead of becoming a finding, so it has none.
test('every rule id has exactly one README anchor', () => {
  const ruleIds = [
    ...Object.keys(require('../../lib/performance/rule-ids.cjs').impactByRule),
    ...Object.keys(require('../../lib/maintainability/rule-ids.cjs').impactByRule),
  ].filter((ruleId) => ruleId !== 'syntax-error');
  const anchorCount = (ruleId) => readme.split(`<a id="${ruleId}"></a>`).length - 1;
  assert.deepEqual(
    ruleIds.filter((ruleId) => anchorCount(ruleId) !== 1),
    [],
  );
});
