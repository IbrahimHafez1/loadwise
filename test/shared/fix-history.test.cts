import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { enableHistory, saveReviewOutcomes, historyReport } from '../../lib/shared/fix-history.cjs';
import type { FixChange, Finding } from '../../lib/shared/types.cjs';
import type { TestContext } from 'node:test';
import type { FixableFinding } from '../types/findings.cjs';
import { isolateHistory } from './history-test-state.cjs';
import { findProjectRoot } from '../../lib/shared/agent-init.cjs';
import * as performance from '../../lib/performance/fix-cli.cjs';
import * as maintainability from '../../lib/maintainability/fix-cli.cjs';
isolateHistory();

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const example = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
const untouched = '// existing unrelated change outside every edited hunk';

function fixture(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-history-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"files":["slow.ts","connection.ts"]}');
  fs.writeFileSync(
    path.join(root, 'connection.ts'),
    'export const config = { ssl: { rejectUnauthorized: false as const } };',
  );
  const resetSource = () => fs.writeFileSync(path.join(root, 'slow.ts'), untouched + '\n' + example);
  resetSource();
  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  }
  const history = (...checkers: string[]) => JSON.parse(run('agent', 'history', ...checkers));
  return { root, run, history, resetSource };
}

test('automatic and explicit sessions share prior decisions while manual fixes require explicit recording', (context) => {
  const { root, run, history, resetSource } = fixture(context);
  context.after(() => {
    process.env.LOADWISE_AGENT = '0';
  });
  process.env.LOADWISE_AGENT = '1';
  assert.deepEqual(history(), { enabled: true, runs: [], reviews: [] });
  const decision = {
    checker: 'perf',
    id: 'reviewed-in-session',
    status: 'verified',
    evidence: 'Checked the first-match contract.',
  };
  assert.equal(saveReviewOutcomes(root, [decision]), 1);
  run('fix', '--yes', 'performance');
  const first = history();
  assert.equal(first.runs[0].applied.length, 3);

  process.env.LOADWISE_AGENT = '0';
  assert.deepEqual(history(), first);
  resetSource();
  run('fix', '--yes', 'performance');
  assert.deepEqual(history(), first);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);

  run('agent', 'init');
  assert.equal(saveReviewOutcomes(root, [decision]), 0);
  const later = {
    ...decision,
    status: 'intentional',
    evidence: 'The exported interface preserves the documented first-match contract.',
  };
  assert.equal(saveReviewOutcomes(root, [later]), 1);
  resetSource();
  run('fix', '--yes', 'performance');
  const merged = history();
  assert.equal(merged.runs.length, 2);
  assert.deepEqual(merged.runs[0], first.runs[0]);
  assert.deepEqual(merged.reviews, [later]);
});

test('history in independent package-less projects does not use an ancestor workspace or home npm manifest', (context) => {
  const { root } = fixture(context);
  context.mock.method(os, 'homedir', () => root);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const source = path.join(first, 'src');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, 'jsconfig.json'), '{}');
  assert.equal(findProjectRoot(source), first);
  assert.equal(findProjectRoot(second), second);
  enableHistory(source);
  assert.equal(historyReport(first, []).enabled, true);
  assert.equal(historyReport(second, []).enabled, false);

  const nested = path.join(first, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(first, 'package.json'), '{}');
  fs.writeFileSync(path.join(nested, '.git'), 'gitdir: /example/worktrees/nested');
  assert.equal(findProjectRoot(nested), nested);
});

test('explicit sibling source fixes use the source project history; separate project batches are reported', (context) => {
  const caller = fixture(context);
  const target = fixture(context);
  const slow = path.relative(caller.root, path.join(target.root, 'slow.ts'));
  const cookie = path.relative(caller.root, path.join(target.root, 'connection.ts'));
  fs.appendFileSync(
    path.join(target.root, 'connection.ts'),
    "\ndeclare const res: any;\nres.cookie('session', 'x', { secure: true, sameSite: 'lax' });\n",
  );
  const spawnLoadwise = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: caller.root,
      encoding: 'utf8',
      env: { ...process.env, LOADWISE_AGENT: '1' },
    });
  // The cookie flag fix needs individual review, so it is applied by id instead of by --yes.
  const run = (checker: string, ...files: string[]) => {
    if (checker !== 'sec') return spawnLoadwise(checker, ...files, '--fix', '--yes');
    const [file] = files;
    const scan = spawnLoadwise(checker, file, '--json');
    const { id } = JSON.parse(scan.stdout).findings.find(
      ({ ruleId }: Finding) => ruleId === 'cookie-missing-security-flags',
    );
    return spawnLoadwise(checker, file, '--fix', '--only', id);
  };
  for (const [checker, file] of [
    ['perf', slow],
    ['sec', cookie],
  ]) {
    const result = run(checker, file);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(target.history(checker).runs[0]?.applied.length, result.stderr + result.stdout);
  }
  assert.equal(caller.history().enabled, false);
  target.resetSource();
  const mixed = run('perf', slow, 'slow.ts');
  assert.equal(mixed.status, 0, mixed.stderr + mixed.stdout);
  assert.match(mixed.stderr, /separate projects/);
  assert.equal(target.history().runs.length, 2);
  assert.equal(caller.history().enabled, false);
});

test('only initialized projects append local history across fresh CLI processes, and clean scans retain earlier runs', (context) => {
  const { run, history, resetSource } = fixture(context);
  const empty = { enabled: false, runs: [], reviews: [] };
  run('fix', '--yes', 'performance');
  assert.deepEqual(history(), empty);
  resetSource();
  assert.match(run('agent', 'init'), /Local review history/);
  assert.deepEqual(history(), { ...empty, enabled: true });
  run('fix', '--yes', 'performance', 'security');
  const first = history();
  assert.equal(first.runs.length, 1);
  assert.equal(first.runs[0].applied.length, 3);
  assert.equal(first.runs[0].manual[0].checker, 'sec');
  assert.ok(!JSON.stringify(first).includes(untouched));
  assert.ok(
    first.runs[0].applied.every((item: FixableFinding) =>
      item.fix.changes.every((change: FixChange) => change.before && change.after),
    ),
  );
  assert.equal(history('security').runs[0].applied.length, 0);
  run('fix', '--yes', 'perf');
  assert.deepEqual(history(), first);
  const separate = fixture(context);
  assert.deepEqual(separate.history(), empty);
  resetSource();
  run('fix', '--all', 'performance');
  assert.equal(history().runs.length, 2);
  assert.deepEqual(history().runs[0], first.runs[0]);
});

test('targeted fixes record only successful actual hunks, including partial success, and outcomes are saved once', (context) => {
  const { run, history, root } = fixture(context);
  run('agent', 'init');
  const result = spawnSync(process.execPath, [bin, 'perf', 'slow.ts', '--json'], { cwd: root, encoding: 'utf8' });
  const [finding] = JSON.parse(result.stdout).findings;
  const selection = spawnSync(
    process.execPath,
    [bin, 'perf', 'slow.ts', '--fix', '--only', finding.id + ',bad', '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(selection.status, 2, selection.stderr);
  const [runInfo] = history().runs;
  assert.deepEqual(
    runInfo.applied.map((item: Finding) => item.id),
    [finding.id],
  );
  assert.deepEqual(runInfo.failed, [{ id: 'bad', reason: 'unknown id', checker: 'perf' }]);
  assert.deepEqual(runInfo.alreadyApplied, []);
  for (const change of runInfo.applied[0].fix.changes) {
    assert.ok((untouched + '\n' + example).includes(change.before));
    assert.ok(fs.readFileSync(path.resolve(root, change.file), 'utf8').includes(change.after));
  }
  const verdict = { checker: 'perf', id: finding.id, status: 'verified', evidence: 'Diff and regression test match.' };
  assert.equal(saveReviewOutcomes(root, [verdict]), 1);
  assert.equal(saveReviewOutcomes(root, [verdict]), 0);
  assert.deepEqual(history('performance').reviews, [verdict]);
  assert.deepEqual(history('security').reviews, []);
  const revised = { ...verdict, evidence: 'Rechecked the modified caller.' };
  assert.equal(saveReviewOutcomes(root, [revised]), 1);
  assert.deepEqual(history().reviews, [revised]);
});

test('unsafe history storage leaves an applied fix successful without following a directory link', (context) => {
  const { root, run } = fixture(context);
  const directory = enableHistory(root);
  const destination = path.join(root, 'untrusted');
  fs.mkdirSync(destination);
  fs.rmdirSync(directory);
  fs.symlinkSync(destination, directory, process.platform === 'win32' ? 'junction' : 'dir');
  const fixed = spawnSync(process.execPath, [bin, 'fix', '--yes', 'performance', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(JSON.parse(fixed.stdout).applied.length, 3);
  assert.match(fixed.stderr, /review history unavailable/);
  assert.deepEqual(fs.readdirSync(destination), []);
  assert.match(run('agent', 'history', '--help'), /Usage/);
  assert.throws(() => saveReviewOutcomes(root, []), /private, user-owned/);
});

test(
  'per-checker terminal fixes retain accepted hunks and declined work across CLI sessions',
  { timeout: 20000 },
  async (context) => {
    const { root, history, run } = fixture(context);
    run('agent', 'init');
    const simulateTerminal = path.join(root, 'tty.cjs');
    fs.writeFileSync(simulateTerminal, "Object.defineProperty(process.stdin, 'isTTY', { value: true });");
    const child = spawn(process.execPath, ['--require', simulateTerminal, bin, 'perf', 'slow.ts', '--fix'], {
      cwd: root,
    });
    context.after(() => child.kill());
    const answers = ['y', 'n', 'q'];
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      if (!output.includes('uit: ')) return;
      output = '';
      child.stdin.write(answers.shift() + '\n');
    });
    const exit = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(exit, 0);
    assert.deepEqual(answers, []);
    const [interactive] = history('perf').runs;
    assert.equal(interactive.applied.length, 1);
    assert.equal(interactive.pendingReview.length, 2);
    assert.deepEqual(interactive.failed, []);
    run('perf', 'slow.ts', '--fix', '--yes');
    const records = history('performance').runs;
    assert.equal(records.length, 2);
    assert.deepEqual(
      records[1].applied.map(({ id }: Finding) => id).sort(),
      interactive.pendingReview.map(({ id }: Finding) => id).sort(),
    );
    run('perf', 'slow.ts', '--fix', '--yes');
    assert.deepEqual(history('perf').runs, records);
  },
);

test('history stores the actual shifted and merged lines and correctly identifies duplicate maintainability edits', (context) => {
  const { root, history } = fixture(context);
  const directory = enableHistory(root);
  const file = path.join(root, 'edit.ts');
  const existing = "import { old, extra } from 'lib';";
  const merged = "import { old, extra, added } from 'lib';";
  fs.writeFileSync(file, ['// earlier user edit', existing, 'const value = 1;'].join('\n'));
  const finding: Finding = {
    id: 'merge',
    ruleId: 'merge',
    message: 'merge',
    fix: {
      changes: [{ file, line: 1, before: "import { old } from 'lib';", after: "import { old, added } from 'lib';" }],
    },
  };
  assert.equal(performance.applyChosenFixes([finding], ['merge'], { json: true, project: root, checker: 'sec' }), 0);
  const [change] = history('security').runs[0].applied[0].fix.changes;
  assert.deepEqual(change, { file, line: 2, before: existing, after: merged });
  const shared = { changes: [{ file, line: 3, before: 'const value = 1;', after: '// extracted\nconst value = 1;' }] };
  const findings = ['first', 'second'].map((id): Finding => ({ id, ruleId: id, message: id, fix: shared }));
  assert.equal(maintainability.applyChosenFixes(findings, ['first', 'second'], root, { json: true }), 0);
  const [applied] = history('maintainability').runs;
  assert.deepEqual(applied.alreadyApplied, [{ id: 'second', checker: 'maint' }]);
  assert.deepEqual(applied.applied[0].fix.changes, shared.changes);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(directory))
      assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
  }
});

test('checker-specific --yes scopes security and maintainability history to their own findings', (context) => {
  const { root, history, run } = fixture(context);
  const nest = path.join(root, 'node_modules/@nestjs/common');
  fs.mkdirSync(nest, { recursive: true });
  fs.writeFileSync(
    path.join(nest, 'index.d.ts'),
    'export declare class ValidationPipe { constructor(options?: object); }',
  );
  fs.appendFileSync(
    path.join(root, 'connection.ts'),
    [
      '',
      "import { ValidationPipe } from '@nestjs/common';",
      'export const pipe = new ValidationPipe();',
      'declare const res: any;',
      "res.cookie('session', 'x', { secure: true, sameSite: 'lax' });",
    ].join('\n'),
  );
  run('agent', 'init');
  // The cookie flag fix needs individual review, so choosing it by id is what applies it.
  const scan = spawnSync(process.execPath, [bin, 'sec', '--json'], { cwd: root, encoding: 'utf8' });
  const { id: cookieId } = JSON.parse(scan.stdout).findings.find(
    ({ ruleId }: Finding) => ruleId === 'cookie-missing-security-flags',
  );
  run('sec', '--fix', '--only', cookieId);
  const [security] = history('sec').runs;
  assert.deepEqual(
    security.applied.map(({ ruleId }: Finding) => ruleId),
    ['cookie-missing-security-flags'],
  );
  fs.writeFileSync(
    path.join(root, 'nested.cjs'),
    [
      'function pick(items, flag) {',
      '  let total = 0;',
      '  for (const item of items) {',
      '    if (item) {',
      '      if (flag || item.forced) {',
      '        if (item.value > 1) total += item.value;',
      '      }',
      '    }',
      '    total += 1;',
      '  }',
      '  return total;',
      '}',
      'module.exports = { pick };',
    ].join('\n'),
  );
  run('maint', '--fix', '--yes');
  const [maintainability] = history('maint').runs;
  assert.ok(maintainability.applied.some(({ ruleId }: Finding) => ruleId === 'deep-control-flow'));
  assert.equal(history().runs.length, 2);
});
