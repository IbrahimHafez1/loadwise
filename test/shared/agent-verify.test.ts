import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');

function fixture(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(base, 'loadwise-review-coverage-'));
  const directory = path.join(scratch, 'project');
  const state = path.join(scratch, 'state');
  fs.mkdirSync(directory);
  fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const agent = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'agent', ...args], {
      cwd: directory,
      env: { ...process.env, LOCALAPPDATA: state, XDG_STATE_HOME: state, LOADWISE_AGENT: '0' },
      encoding: 'utf8',
    });
  return {
    agent,
    write(file: string, object: object) {
      fs.writeFileSync(path.join(directory, file), JSON.stringify(object));
    },
    run(...reports: string[]) {
      return agent('verify', '--outcomes', 'outcomes.json', ...reports);
    },
  };
}

const lookup = { id: 'shared-id', checker: 'perf' };
const signature = { id: 'shared-id', checker: 'maint' };
const headers = { id: 'headers', checker: 'sec' };
const run = { applied: [lookup], manual: [signature], pendingReview: [headers] };
const decisions = [
  { ...lookup, status: 'verified', evidence: 'The empty-input test observes zero customer reads.' },
  {
    ...signature,
    status: 'intentional',
    evidence: 'The loader calls the six-position signature through Reflect.apply.',
  },
  { ...headers, status: 'deferred', evidence: 'Header ownership depends on the reverse proxy configuration.' },
];

test('verifies scan and write history once per checker and id and keeps deferred outcomes separate', (context) => {
  const project = fixture(context);
  project.write('scan.json', { maintainability: { findings: [{ id: 'shared-id' }] }, security: { findings: [] } });
  project.write('fix.json', run);
  project.write('history.json', {
    enabled: true,
    runs: [{ ...run, alreadyApplied: [lookup], failed: [{ ...headers, reason: 'file changed' }] }],
  });
  project.write('outcomes.json', { outcomes: decisions });
  const result = project.run('scan.json', 'fix.json', 'history.json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.expected, 3);
  assert.equal(report.reviewed, 3);
  assert.equal(report.counts.fixed, 0);
  assert.equal(report.counts.deferred, 1);
  assert.equal(report.failedApplications[0].reason, 'file changed');
});

test('rejects duplicated, missing, malformed, placeholder and out-of-scope outcomes', (context) => {
  const project = fixture(context);
  project.write('fix.json', run);
  project.write('outcomes.json', {
    outcomes: [
      decisions[0],
      { ...decisions[0], checker: 'performance' },
      { ...decisions[1], evidence: ' TODO ' },
      { ...decisions[2], id: 'unreported' },
      null,
    ],
  });
  const result = project.run('fix.json');
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.reviewed, 0);
  assert.deepEqual(report.missing, [headers]);
  assert.deepEqual(report.duplicates, [{ ...lookup, count: 2 }]);
  assert.equal(report.unexpected[0].id, 'unreported');
  assert.equal(report.invalid.length, 2);
  project.write('outcomes.json', { outcomes: decisions.map((item) => ({ ...item, status: 'unknown' })) });
  assert.equal(JSON.parse(project.run('fix.json').stdout).invalid.length, 3);
});

test('accounts for failed and previously applied IDs, clean scans, and unavailable coverage', (context) => {
  const project = fixture(context);
  project.write('history.json', {
    enabled: true,
    runs: [
      {
        applied: [],
        manual: [],
        pendingReview: [],
        alreadyApplied: [lookup],
        failed: [{ ...headers, reason: 'overlap' }],
      },
    ],
  });
  project.write('outcomes.json', { outcomes: [] });
  const withFailures = project.run('history.json');
  assert.equal(withFailures.status, 1);
  assert.deepEqual(JSON.parse(withFailures.stdout).missing, [lookup, headers]);
  project.write('scan.json', { performance: { findings: [] }, security: null });
  const skipped = project.run('scan.json');
  assert.equal(skipped.status, 1);
  assert.equal(JSON.parse(skipped.stdout).unavailable[0].checker, 'sec');
  project.write('scan.json', { performance: { findings: [] } });
  project.write('history.json', { enabled: false, runs: [] });
  assert.equal(project.run('scan.json', 'history.json').status, 1);
  project.write('history.json', { enabled: true, runs: [] });
  assert.equal(project.run('scan.json', 'history.json').status, 0);
});

test('unreadable inputs, wrong document shapes and ambiguous finding identifiers fail as input errors', (context) => {
  const project = fixture(context);
  project.write('outcomes.json', { outcomes: [] });
  assert.equal(project.run('missing.json').status, 2);
  for (const malformed of [
    {},
    { applied: [] },
    { ...run, security: null },
    { security: {} },
    { security: { findings: [lookup] } },
    { enabled: true, runs: [null] },
    { unrelated: [] },
  ]) {
    project.write('scan.json', malformed);
    const result = project.run('scan.json');
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  project.write('outcomes.json', { outcomes: {} });
  project.write('scan.json', { security: { findings: [] } });
  assert.equal(project.run('scan.json').status, 2);
});

test('explicit save remembers manually judged findings across sessions and requires a fresh scoped decision', (context) => {
  const project = fixture(context);
  const manual = {
    ...signature,
    file: 'compat.js',
    line: 12,
    column: 2,
    ruleId: 'long-parameter-list',
    message: 'Original diagnostic',
    fix: { changes: [{ before: 'source-hunk' }] },
  };
  const clean = { maintainability: { findings: [] } };
  project.write('before.json', { maintainability: { findings: [manual] }, performance: { findings: [lookup] } });
  project.write('outcomes.json', { outcomes: decisions.slice(0, 2) });
  assert.equal(project.run('--save', 'before.json').status, 2);
  assert.equal(project.agent('init').status, 0);
  function history(...checkers: string[]) {
    const result = project.agent('history', ...checkers);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  assert.equal(project.run('before.json').status, 0);
  assert.deepEqual(history().reviews, []);
  const initial = project.run('--save', 'before.json');
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(JSON.parse(initial.stdout).saved, 2);
  assert.equal(JSON.parse(project.run('--save', 'before.json').stdout).saved, 0);
  const scoped = history('maintainability');
  assert.equal(scoped.reviews.length, 1);
  const [saved] = scoped.reviews;
  assert.deepEqual(saved, {
    ...decisions[1],
    file: manual.file,
    line: manual.line,
    column: manual.column,
    ruleId: manual.ruleId,
  });
  assert.deepEqual(history('security').reviews, []);
  project.write('history.json', scoped);
  project.write('clean.json', clean);
  project.write('outcomes.json', { outcomes: [] });
  const missing = project.run('--save', 'history.json', 'clean.json');
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).missing[0].id, manual.id);
  assert.deepEqual(history('maint').reviews, [saved]);
  const current = {
    ...decisions[1],
    status: 'fixed',
    evidence: 'The compatibility adapter and its contract tests now cover both call signatures.',
  };
  project.write('outcomes.json', { outcomes: [current] });
  const rechecked = project.run('--save', 'history.json', 'clean.json');
  assert.equal(rechecked.status, 0, rechecked.stderr);
  assert.equal(history('maint').reviews[0].status, 'fixed');
  assert.equal(history('perf').reviews.length, 1);
});

test('reconciles standalone scans, migrations and database reports without filtering other report types', (context) => {
  const project = fixture(context);
  project.write('migrations.json', { scannedFiles: 1, findings: [{ id: lookup.id }] });
  project.write('db.json', { engine: 'postgres', findings: [{ id: 'db-index', target: 'orders' }], notes: [] });
  project.write('combined.json', { security: { findings: [headers] } });
  project.write('history.json', { enabled: true, runs: [], reviews: [signature] });
  const dbOutcome = { ...decisions[0], id: 'db-index', evidence: 'The orders schema has an index on customer_id.' };
  project.write('outcomes.json', { outcomes: [...decisions, dbOutcome] });
  const result = project.run('--checker', 'performance', 'migrations.json', 'db.json', 'combined.json', 'history.json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reviewed, 4);
  project.write('outcomes.json', { outcomes: [decisions[1]] });
  project.write('maint.json', { mode: 'source', checker: 'maintainability', findings: [{ id: signature.id }] });
  assert.equal(project.run('maint.json').status, 0);
  project.write('sec.json', { findings: [headers] });
  project.write('outcomes.json', { outcomes: [decisions[2]] });
  assert.equal(project.run('sec.json').status, 0);
  project.write('outcomes.json', { outcomes: [] });
  project.write('empty.json', { scannedFiles: 1, findings: [] });
  assert.equal(project.run('--checker', 'sec', 'empty.json').status, 0);
  const missing = project.run('--checker', 'sec', 'sec.json');
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout).missing, [headers]);
});

test('rejects ambiguous standalone inputs, missing ids and conflicting checker declarations', (context) => {
  const project = fixture(context);
  project.write('outcomes.json', { outcomes: [] });
  for (const findings of [[], [{ id: 'untagged' }], [headers, { id: 'untagged' }]]) {
    project.write('raw.json', { findings });
    const result = project.run('raw.json');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /needs --checker/);
  }
  for (const report of [
    { findings: [lookup] },
    { findings: [{}] },
    { checker: 'unknown', findings: [] },
    { checker: 'maint', findings: [] },
    { findings: [{ ...headers, checker: null }] },
    { findings: [], security: { findings: [] } },
  ]) {
    project.write('raw.json', report);
    assert.equal(project.run('--checker', 'sec', 'raw.json').status, 2);
  }
  project.write('raw.json', { findings: [] });
  assert.equal(project.run('--checker', 'sec,perf', 'raw.json').status, 2);
  assert.equal(project.run('--checker', 'perf', '--checker', 'sec', 'raw.json').status, 2);
});
