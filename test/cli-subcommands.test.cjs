'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { knownRules } = require('../lib/rule-ids.cjs');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin/backend-perf-check.cjs');
const fakeSubcommands = path.join(__dirname, 'fake-subcommands.cjs');

function run(args, nodeOptions = []) {
  return spawnSync(process.execPath, [...nodeOptions, bin, ...args], { cwd: root, encoding: 'utf8' });
}

function snapshotFile(context, contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-subcommands-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'snapshot.json');
  fs.writeFileSync(filename, JSON.stringify(contents));
  return filename;
}

test('migrations and db dispatch to their modules with the remaining arguments', () => {
  for (const command of ['migrations', 'db']) {
    const result = run([command, '--json', 'extra'], ['--require', fakeSubcommands]);
    assert.equal(result.status, 3, result.stderr);
    assert.equal(result.stderr, 'fake loaded: ' + command + '\n');
    assert.deepEqual(JSON.parse(result.stdout), { command, argv: ['--json', 'extra'] });
  }
});

test('source scans never load the migrations or db modules', () => {
  const result = run(['examples/slow.ts'], ['--require', fakeSubcommands]);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /fake loaded/);
});

test('usage lists the new commands and the schema flag', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /backend-perf-check migrations /);
  assert.match(help.stdout, /backend-perf-check db /);
  assert.match(help.stdout, /--schema snapshot\.json/);
});

test('--ignore accepts index, migration, database and new source rule ids', () => {
  for (const ruleId of [
    'index-missing-foreign-key',
    'index-unusable-expression',
    'migration-index-not-concurrent',
    'migration-mysql-lock-unspecified',
    'db-unused-index',
    'mongo-collection-scan-observed',
    'redis-command-in-loop',
    'password-hash-sync-in-async',
  ]) {
    assert.ok(knownRules.has(ruleId), ruleId);
  }
  const result = run(['examples/indexed.ts', '--ignore', 'migration-breaking-drop', '--ignore', 'db-missing-index']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run(['examples/indexed.ts', '--ignore', 'migration-everything']).status, 2);
});

test('--schema validates the snapshot before scanning', (context) => {
  const valid = snapshotFile(context, { version: 1, dialect: 'postgres', tables: {} });
  assert.equal(run(['examples/indexed.ts', '--schema', valid]).status, 0);
  const future = run(['examples/indexed.ts', '--schema', snapshotFile(context, { version: 2, tables: {} })]);
  assert.equal(future.status, 2);
  assert.match(future.stderr, /Unsupported schema snapshot version/);
  assert.equal(run(['examples/indexed.ts', '--schema', path.join(root, 'missing-snapshot.json')]).status, 2);
});

test('findings carry their fix example in text and JSON', () => {
  const json = run(['examples/slow.ts', '--json']);
  assert.equal(json.status, 1, json.stderr);
  const [membership] = JSON.parse(json.stdout).findings;
  assert.equal(membership.ruleId, 'array-repeated-membership');
  assert.equal(membership.example.language, 'typescript');
  assert.match(membership.example.code, /new Set\(allowedIds\)/);
  assert.equal(typeof membership.example.note, 'string');
  const text = run(['examples/slow.ts']);
  assert.match(text.stdout, /\[array-repeated-membership\] .*\n {2}Fix:\n {4}const allowed = new Set\(allowedIds\);\n/);
  assert.doesNotMatch(text.stdout, /Impact:/, 'no impact without a loop rule');
});
