import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  allowedHeapMegabytes,
  childHeapFlags,
  isHeapExhaustion,
  recommendedHeapMegabytes,
  userSetHeapLimit,
} from '../../lib/shared/heap-limit.js';
import { formatGithub } from '../../lib/shared/formats/github.js';
import { formatSarif } from '../../lib/shared/formats/sarif.js';
import type { TestContext } from 'node:test';
import type { FileMap } from '../types/project-files.js';

import type { ReportEntry } from '../../lib/shared/types/report-formats.js';
const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const bytesPerGigabyte = 1024 ** 3;
const tinyHeapOption = '--max-old-space-size=8';
const findingSource =
  'export function check(keys: string[], raw: string) { const ids: string[] = JSON.parse(raw); return keys.map(key => ids.includes(key)); }';

function project(context: TestContext, files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-check-failures-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}

function quietProject(context: TestContext) {
  return project(context, { 'a.ts': 'export const a = 1;\n', 'tsconfig.json': '{"include":["*.ts"]}' });
}

function skippedFileProject(context: TestContext) {
  return project(context, {
    'flag.ts': findingSource,
    'broken.ts': 'export const broken = ;',
    'tsconfig.json': '{"compilerOptions":{"target":"ES2022","strict":true},"files":["flag.ts","broken.ts"]}',
  });
}

function loadwise(root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOADWISE_AGENT: '0', LOADWISE_NO_CACHE: '1', ...env },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('heap limit is a bounded fraction of memory and never below the default', () => {
  assert.equal(recommendedHeapMegabytes(64 * bytesPerGigabyte, 4144), 16384);
  assert.equal(recommendedHeapMegabytes(2 * bytesPerGigabyte, 4144), 4144);
  assert.equal(recommendedHeapMegabytes(16 * bytesPerGigabyte, 2048), Math.floor(16 * 1024 * 0.6));
  assert.equal(recommendedHeapMegabytes(4 * bytesPerGigabyte, 8192), 8192);
});

test('a heap limit the user set is never replaced', () => {
  assert.equal(userSetHeapLimit('--max-old-space-size=2048', []), true);
  assert.equal(userSetHeapLimit('--max_old_space_size=2048', []), true);
  assert.equal(userSetHeapLimit('', ['--max-old-space-size=2048']), true);
  assert.equal(userSetHeapLimit('--trace-warnings', []), false);
  assert.deepEqual(childHeapFlags('--max-old-space-size=2048', []), []);
  assert.deepEqual(childHeapFlags('', ['--max-old-space-size=3000']), ['--max-old-space-size=3000']);
  assert.match(childHeapFlags('', [])[0], /^--max-old-space-size=\d+$/);
  assert.equal(allowedHeapMegabytes([], '--max-old-space-size=2048'), 2048);
  assert.equal(allowedHeapMegabytes(['--max-old-space-size=9000'], ''), 9000);
});

test('heap exhaustion needs an abnormal death and the V8 message', () => {
  const dump = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';
  assert.equal(isHeapExhaustion({ code: 134, signal: null, stderr: dump }), true);
  assert.equal(isHeapExhaustion({ code: null, signal: 'SIGABRT', stderr: dump }), true);
  assert.equal(isHeapExhaustion({ code: 2, signal: null, stderr: dump }), false);
  assert.equal(isHeapExhaustion({ code: 134, signal: null, stderr: 'other crash' }), false);
});

// The parent must not run under the tiny heap, so the launcher sets NODE_OPTIONS only after it has
// started and the checker children it spawns inherit it.
const launcher = `process.env.NODE_OPTIONS = ${JSON.stringify(tinyHeapOption)}; process.argv.splice(1, 0, ${JSON.stringify(cli)}); import(${JSON.stringify(pathToFileURL(cli).href)});`;

function checkWithTinyHeap(root: string, args: readonly string[]) {
  const run = spawnSync(process.execPath, ['-e', launcher, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOADWISE_AGENT: '0', LOADWISE_NO_CACHE: '1' },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('--fix on check points to the fix command', (context) => {
  for (const args of [['--fix'], ['check', '--fix']]) {
    const run = loadwise(quietProject(context), args);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /Run `loadwise fix --yes`/);
  }
});

test('a child that runs out of memory gives one clear line and exit 2, never a pass', (context) => {
  const run = checkWithTinyHeap(quietProject(context), ['check', '--only', 'perf', '--json']);
  assert.equal(run.code, 2, run.stderr);
  assert.equal(JSON.parse(run.stdout).performance, null);
  assert.match(run.stderr, /performance checker ran out of memory \(allowed 8 MB\)/);
  assert.match(run.stderr, /NODE_OPTIONS=--max-old-space-size=/);
  assert.doesNotMatch(run.stderr, /Mark-Compact|Native stack/);
  assert.match(run.stderr, /Performance checker produced no result/);
});

test('a crashed child is named in text and JSON output', (context) => {
  const root = quietProject(context);
  const text = checkWithTinyHeap(root, ['check', '--only', 'perf,sec']);
  assert.equal(text.code, 2);
  assert.match(text.stdout, /== Performance ==\nNo result: the performance checker failed/);
  assert.match(text.stdout, /== Security ==\nNo result: the security checker failed/);
  const json = checkWithTinyHeap(root, ['check', '--only', 'perf,sec', '--json']);
  assert.equal(json.code, 2);
  assert.deepEqual(JSON.parse(json.stdout), { performance: null, security: null });
  assert.match(json.stderr, /Performance checker produced no result/);
  assert.match(json.stderr, /Security checker produced no result/);
});

test('findings and skippedFiles survive a child that exits 2 for skipped files', (context) => {
  const root = skippedFileProject(context);
  const json = loadwise(root, ['check', '--only', 'perf,sec', '--json']);
  assert.equal(json.code, 2, json.stderr);
  const { performance, security } = JSON.parse(json.stdout);
  assert.ok(performance.findings.length >= 1);
  assert.equal(performance.skippedFiles.length, 1);
  assert.equal(performance.skippedFiles[0].file.endsWith('broken.ts'), true);
  assert.equal(security.skippedFiles.length, 1);
  assert.match(json.stderr, /broken\.ts/);
  const text = loadwise(root, ['check', '--only', 'perf,sec']);
  assert.equal(text.code, 2);
  assert.match(text.stdout, /flag\.ts/);
  assert.doesNotMatch(text.stdout, /No result/);
});

test('sarif and github formats keep findings and list skipped files', (context) => {
  const root = skippedFileProject(context);
  const sarifRun = loadwise(root, ['check', '--only', 'perf', '--format', 'sarif']);
  assert.equal(sarifRun.code, 2, sarifRun.stderr);
  const [performanceRun] = JSON.parse(sarifRun.stdout).runs;
  assert.ok(performanceRun.results.length >= 1);
  assert.equal(performanceRun.invocations[0].executionSuccessful, false);
  assert.match(performanceRun.invocations[0].toolExecutionNotifications[0].message.text, /broken\.ts/);
  const github = loadwise(root, ['check', '--only', 'perf', '--format', 'github']);
  assert.equal(github.code, 2);
  assert.match(github.stdout, /::(warning|error|notice) file=flag\.ts/);
  assert.match(github.stdout, /::warning file=broken\.ts,title=skipped-file::/);
});

test('format helpers add skipped files only when a report has them', () => {
  const entry: ReportEntry = { pillar: 'performance', root: '.', repositoryDirectory: '.', report: { findings: [] } };
  assert.equal(formatGithub([entry]), '');
  assert.equal(JSON.parse(formatSarif([entry])).runs[0].invocations, undefined);
});
