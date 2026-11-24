import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { applyBaselineOptions, baselineForScan } from '../../lib/shared/baseline.cjs';
import type { MarkerPair } from '../../lib/shared/types/managed-blocks.cjs';
import { replaceBlocks } from '../../lib/shared/managed-blocks.cjs';
import { runReviewMcp } from '../../lib/shared/review-mcp.cjs';
import { writeFileAtomic } from '../../lib/shared/atomic-write.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import type { BaselineCount, BaselineDocument } from '../../lib/shared/types/baseline.cjs';
import { isolateHistory } from './history-test-state.cjs';
import { impactByRule } from '../../lib/performance/rule-ids.cjs';

type BaselineScanValues = Parameters<typeof baselineForScan>[1];

interface ReviewReply {
  id: number;
}

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
isolateHistory();
const blockMarker = '# >>> loadwise pre-commit';

function temporaryDirectory(context: TestContext, prefix: string) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, prefix));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function hookRepository(context: TestContext, existingHook: string) {
  const root = temporaryDirectory(context, 'loadwise-improve-hook-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const hookFile = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, existingHook);
  const installHook = (...args: string[]) =>
    spawnSync(process.execPath, [bin, 'agent', 'init', ...args], { cwd: root, encoding: 'utf8' });
  return { root, hookFile, installHook };
}

test('the hook block goes before a trailing exit, moves there on reinstall, and --hook off still removes it', (context) => {
  const { hookFile, installHook } = hookRepository(context, '#!/bin/sh\necho other tool\nexit 0\n');
  assert.equal(installHook('--hook', 'block').status, 0);
  const installed = fs.readFileSync(hookFile, 'utf8');
  assert.ok(installed.indexOf(blockMarker) < installed.indexOf('\nexit 0'), installed);
  assert.ok(installed.trimEnd().endsWith('exit 0'));
  if (process.platform !== 'win32') assert.ok(fs.statSync(hookFile).mode & 0o100);

  // An earlier release appended the block after the exit; a reinstall moves it where it runs.
  fs.writeFileSync(
    hookFile,
    installed.replace(/\nexit 0\n$/, '').replace('#!/bin/sh\necho other tool\n', '$&exit 0\n'),
  );
  installHook('--hook', 'warn');
  const moved = fs.readFileSync(hookFile, 'utf8');
  assert.ok(moved.indexOf(blockMarker) < moved.indexOf('\nexit 0'), moved);
  assert.equal(moved.match(/>>> loadwise pre-commit/g)?.length, 1);

  assert.equal(installHook('--hook', 'off').status, 0);
  const removed = fs.readFileSync(hookFile, 'utf8');
  assert.ok(!removed.includes(blockMarker));
  assert.match(removed, /echo other tool\n+exit 0\n$/);
});

test('a hook with an earlier top-level exit keeps the install and warns that the block may not run', (context) => {
  const { hookFile, installHook } = hookRepository(context, '#!/bin/sh\nexit 0\necho unreachable\n');
  const run = installHook('--hook', 'block');
  assert.equal(run.status, 0);
  assert.ok(fs.readFileSync(hookFile, 'utf8').includes(blockMarker));
  assert.match(run.stdout + run.stderr, /may not run/);
  // A conditional exit inside a branch is not a reason to warn.
  const quiet = hookRepository(context, '#!/bin/sh\nif [ -n "$SKIP" ]; then\n  exit 0\nfi\n').installHook('--hook');
  assert.doesNotMatch(quiet.stdout + quiet.stderr, /may not run/);
});

test('a start marker that lost its end marker never takes the user text after it', () => {
  const pairs: MarkerPair[] = [['<!-- start -->', '<!-- end -->']];
  const block = '<!-- start -->\nnew\n<!-- end -->';
  const damaged = '# Notes\n\n<!-- start -->\nold body\n\nUser text that must stay.\n';
  const firstInstall = replaceBlocks(damaged, pairs, block);
  assert.equal(firstInstall, '# Notes\n\n' + block + '\nold body\n\nUser text that must stay.\n');
  // A lone start marker followed later by a complete block: only the marker line goes.
  const appendedLater = damaged + '\n' + block + '\n';
  const reinstalled = replaceBlocks(appendedLater, pairs, block);
  assert.ok(reinstalled);
  assert.ok(reinstalled.includes('User text that must stay.'), reinstalled);
  assert.equal(reinstalled.match(/<!-- start -->/g)?.length, 1);
  const removedBlock = replaceBlocks(appendedLater, pairs);
  assert.ok(removedBlock);
  assert.ok(!removedBlock.includes('<!-- start -->'));
  assert.ok(removedBlock.includes('User text that must stay.'));
});

function readPerformanceFindings(root: string): BaselineCount[] {
  const document: BaselineDocument = JSON.parse(fs.readFileSync(path.join(root, 'loadwise-baseline.json'), 'utf8'));
  const findings = document.pillars.performance?.findings;
  assert.ok(findings);
  return findings;
}

function writeWorkspaceProject(context: TestContext) {
  const root = temporaryDirectory(context, 'loadwise-improve-baseline-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  for (const name of ['api', 'web']) {
    fs.mkdirSync(path.join(root, 'packages', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', name, 'package.json'), JSON.stringify({ name }));
  }
  return root;
}

test('--write-baseline on a partial scan keeps entries outside the scanned workspaces and filters', (context) => {
  const root = writeWorkspaceProject(context);
  const finding = (ruleId: string, file: string, id: string): Finding => ({ ruleId, file, id, message: '' });
  const write = (values: BaselineScanValues, findings: Finding[]) =>
    applyBaselineOptions({
      options: baselineForScan({ writeBaseline: {} }, values),
      pillar: 'performance',
      findings,
      projectRoot: root,
      absoluteFileOf: (item) => path.join(root, item.file ?? ''),
    });
  write({}, [
    finding('n-plus-one-query', 'packages/api/a.ts', 'api1'),
    finding('n-plus-one-query', 'packages/web/b.ts', 'web1'),
    finding('unbounded-query', 'packages/api/c.ts', 'api2'),
  ]);
  write({ workspace: ['web'] }, [finding('n-plus-one-query', 'packages/web/b.ts', 'web2')]);
  write({ ignore: ['unbounded-query'] }, [
    finding('n-plus-one-query', 'packages/api/a.ts', 'api1'),
    finding('n-plus-one-query', 'packages/web/b.ts', 'web2'),
  ]);
  const entries = readPerformanceFindings(root);
  assert.deepEqual(
    entries.map(({ ruleId, file, fingerprint }) => [ruleId, file, fingerprint]),
    [
      ['n-plus-one-query', 'packages/api/a.ts', 'api1'],
      ['n-plus-one-query', 'packages/web/b.ts', 'web2'],
      ['unbounded-query', 'packages/api/c.ts', 'api2'],
    ],
  );
  // A full scan still replaces the whole section.
  write({}, []);
  assert.deepEqual(readPerformanceFindings(root), []);
});

test('--write-baseline with --min-impact keeps entries for rules below the threshold', (context) => {
  const root = writeWorkspaceProject(context);
  const lowRule = Object.keys(impactByRule).find((ruleId) => impactByRule[ruleId] === 'low');
  const criticalRule = Object.keys(impactByRule).find((ruleId) => impactByRule[ruleId] === 'critical');
  assert.ok(lowRule);
  assert.ok(criticalRule);
  const write = (values: BaselineScanValues, findings: Finding[]) =>
    applyBaselineOptions({
      options: baselineForScan({ writeBaseline: {} }, values),
      pillar: 'performance',
      findings,
      projectRoot: root,
      absoluteFileOf: (item) => path.join(root, item.file ?? ''),
    });
  write({}, [
    { ruleId: lowRule, file: 'a.ts', id: 'low1', message: '' },
    { ruleId: criticalRule, file: 'a.ts', id: 'critical1', message: '' },
  ]);
  write({ 'min-impact': 'high' }, []);
  const entries = readPerformanceFindings(root);
  assert.deepEqual(
    entries.map(({ ruleId }) => ruleId),
    [lowRule],
  );
});

test('writeFileAtomic replaces through a temporary file and keeps the mode and symlink target', (context) => {
  const root = temporaryDirectory(context, 'loadwise-improve-atomic-');
  const target = path.join(root, 'hook');
  fs.writeFileSync(target, 'old', { mode: 0o755 });
  writeFileAtomic(target, 'new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(root), ['hook']);
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(target, link);
  } catch {
    return;
  }
  writeFileAtomic(link, 'through link');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'through link');
});

test('review-mcp ignores blank and whitespace-only stdin lines', async () => {
  let transcript = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      transcript += chunk;
      done();
    },
  });
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const input = Readable.from(['\n', '   \t\n', ping + '\n', '\r\n']);
  assert.equal(await runReviewMcp(process.cwd(), input, output), 0);
  const replies: ReviewReply[] = transcript
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.id, 1);
});
