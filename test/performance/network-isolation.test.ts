// Invariant I1: only the db command may open a connection or read the database URL variable.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const bin = path.join(root, 'bin/loadwise.js');
const guard = pathToFileURL(path.join(import.meta.dirname, 'network-guard.js')).href;
const sentinel = 'postgres://sentinel-user:sentinel-pass@sentinel-host.invalid:5432/sentinel';
const environment = { ...process.env, DATABASE_URL: sentinel, LOADWISE_EDITOR_SCAN: '1' };
const watchTimeoutMs = 60000;

function runGuarded(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', guard, ...args], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: watchTimeoutMs,
  });
}

function assertIsolated(result: { stdout: string; stderr: string }, label: string) {
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /I1-VIOLATION/, label);
  assert.doesNotMatch(output, /sentinel-(user|pass|host)/, label);
}

test('the guard itself detects connects and package reads of the URL variable', () => {
  const connect = runGuarded(['-e', "try { require('node:net').connect(9, '127.0.0.1'); } catch {}"]);
  assert.match(connect.stderr, /I1-VIOLATION net connect/);
  const read = runGuarded([path.join(import.meta.dirname, 'env-probe.js')]);
  assert.match(read.stderr, /I1-VIOLATION env read of DATABASE_URL/);
});

for (const args of [
  ['examples/slow.ts'],
  ['-p', 'examples/tsconfig.json', '--json'],
  ['plan', 'examples/postgres-plan.json'],
  ['traces', 'examples/repeated-db.otlp.json'],
  ['polyglot', 'examples/labels.py'],
  ['migrations', 'examples'],
]) {
  test('no connection or URL read: ' + args.join(' '), () => {
    const result = runGuarded([bin, 'perf', ...args]);
    assert.notEqual(result.status, null, 'command timed out');
    assertIsolated(result, args.join(' '));
  });
}

test('no connection or URL read: --watch', async () => {
  const child = spawn(process.execPath, ['--import', guard, bin, 'perf', '--watch', '-p', 'examples/tsconfig.json'], {
    cwd: root,
    env: environment,
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watch produced no result: ' + stderr)), watchTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!/file\(s\) checked/.test(stdout)) return;
      clearTimeout(timer);
      resolve();
    });
  }).finally(() => child.kill());
  assertIsolated({ stdout, stderr }, '--watch');
});
