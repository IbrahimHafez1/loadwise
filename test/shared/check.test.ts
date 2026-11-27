import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Finding } from '../../lib/shared/types.js';
import type { TestContext } from 'node:test';
import type { FileMap } from '../types/project-files.js';

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const slowSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/slow.ts'), 'utf8');
const quietSource = 'export function double(value: number) {\n  return value * 2;\n}\n';
const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] });

function project(context: TestContext, files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-check-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}

function loadwise(root: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOADWISE_AGENT: '0' },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('standalone JavaScript packages share inferred sources and respect staged-only scans', (context) => {
  const source = "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n";
  const root = project(context, {
    'package.json': '{}',
    'connection.cjs': source,
    'entry.mjs': 'export const count = 1;\n',
  });
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'generated.ts'), 'export {};');
  const all = loadwise(root, 'check', '--json');
  const { performance, security } = JSON.parse(all.stdout);
  assert.equal(performance.scannedFiles, 2, all.stderr);
  assert.equal(security.scannedFiles, 2);
  assert.ok(security.findings.some(({ ruleId }: Finding) => ruleId === 'tls-verification-disabled'));
  const fix = loadwise(root, 'fix', '--all');
  assert.equal(fix.code, 0, fix.stderr);
  assert.equal(fs.existsSync(path.join(root, 'jsconfig.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'connection.cjs'), 'utf8'), source);
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  git('init', '--quiet');
  git('add', 'entry.mjs');
  const staged = loadwise(root, 'check', '--only', 'perf,sec', '--staged', '--json');
  assert.equal(staged.code, 0, staged.stderr);
  assert.deepEqual(JSON.parse(staged.stdout).security.findings, []);
});

test('adding a TypeScript implementation file keeps a configless mixed project out of inferred JS bulk mode', (context) => {
  const root = project(context, { 'package.json': '{}', 'index.js': 'module.exports = {};', 'impl.ts': 'export {};' });
  const fix = loadwise(root, 'fix', '--all');
  assert.equal(fix.code, 2, fix.stdout + fix.stderr);
  assert.match(fix.stderr, /No tsconfig\.json or jsconfig\.json in .+ Run loadwise fix from the project folder\./);
});

test('plain loadwise checks the current folder with every checker in titled sections', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': quietSource });
  const run = loadwise(root);
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /agent instructions/);
  assert.match(
    run.stdout,
    /^== Performance ==\n1 file\(s\) checked, 0 finding\(s\)\.\n== Reliability ==\n1 file\(s\) checked, 0 finding\(s\)\.\n== Maintainability ==\n.*\n== Security ==\n1 file\(s\) checked, 0 finding\(s\)\.\n$/,
  );
  assert.deepEqual(loadwise(root, 'check', '.'), run);
});

test('a performance finding exits 1 and prints the per-checker fix command instead of fixing', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const run = loadwise(root, 'check');
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stdout, /Fix all: npx loadwise perf -p tsconfig\.json --engine js --fix --only [0-9a-f,]+\n/);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), slowSource);
});

test('--json prints one key per checker', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const run = loadwise(root, '--json');
  const report = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(report), ['performance', 'reliability', 'maintainability', 'security', 'accessibility']);
  assert.equal(report.performance.findings.length, 3);
  assert.deepEqual(report.maintainability.findings, []);
  assert.deepEqual(report.security.findings, []);
  assert.equal(report.accessibility, null, 'a project without frontend sources skips accessibility');
});

test('one checker with invalid configuration makes check exit 2 and its JSON report null', (context) => {
  const root = project(context, {
    'tsconfig.json': tsconfig,
    'a.ts': slowSource,
    'loadwise.config.json': JSON.stringify({ maintainability: { exclude: 'generated' } }),
  });
  const run = loadwise(root, '--json');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /exclude must be an array/);
  const report = JSON.parse(run.stdout);
  assert.equal(report.maintainability, null);
  assert.equal(report.performance.findings.length, 3);
});

test('without a tsconfig or jsconfig the performance, reliability and security checkers are skipped with a note', (context) => {
  const root = project(context, { 'a.ts': quietSource });
  const run = loadwise(root, '--json');
  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stderr,
    /no tsconfig\.json or jsconfig\.json in .*; skipped the performance, reliability and security checkers\./,
  );
  assert.equal(JSON.parse(run.stdout).performance, null);
  assert.equal(JSON.parse(run.stdout).reliability, null);
  assert.equal(JSON.parse(run.stdout).security, null);
});

test('--only and --skip select checkers, and --json keys follow the selection', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const keys = (...args: string[]) => Object.keys(JSON.parse(loadwise(root, '--json', ...args).stdout));
  assert.deepEqual(keys('--only', 'maint'), ['maintainability']);
  assert.deepEqual(keys('--only', 'maint,perf,maint'), ['performance', 'maintainability']);
  assert.deepEqual(keys('--skip', 'perf'), ['reliability', 'maintainability', 'security', 'accessibility']);
  assert.deepEqual(keys('--only', 'rel'), ['reliability']);
  assert.deepEqual(keys('--only', 'sec'), ['security']);
  assert.deepEqual(keys('--skip', 'sec'), ['performance', 'reliability', 'maintainability', 'accessibility']);
  const maintOnly = loadwise(root, '--only', 'maint');
  assert.equal(maintOnly.code, 0, 'the performance findings are not checked');
  assert.doesNotMatch(maintOnly.stdout, /== Performance ==/);
});

test('invalid checker selections exit 2 and name the valid checkers', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': quietSource });
  const unknown = loadwise(root, '--only', 'perf,lint');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown --only name "lint"; use perf, rel, maint, sec, a11y\./);
  const both = loadwise(root, '--only', 'perf', '--skip', 'maint');
  assert.equal(both.code, 2);
  assert.match(both.stderr, /Choose either --only or --skip\./);
  assert.equal(loadwise(root, '--skip', 'perf,rel,maint,sec,a11y').code, 2);
});

test('perf and sec selected together share one child whose envelope splits into two reports', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const run = loadwise(root, 'perf', '-p', 'tsconfig.json', '--with', 'sec', '--json');
  assert.equal(run.code, 1, run.stderr);
  const envelope = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(envelope), ['performance', 'security']);
  assert.equal(envelope.performance.code, 1);
  assert.equal(JSON.parse(envelope.performance.stdout).findings.length, 3);
  assert.deepEqual(envelope.security, {
    code: 0,
    stdout: JSON.stringify({ scannedFiles: 1, findings: [] }, null, 2) + '\n',
  });
  const check = JSON.parse(loadwise(root, '--json', '--only', 'perf,sec').stdout);
  assert.deepEqual(check, {
    performance: JSON.parse(envelope.performance.stdout),
    security: JSON.parse(envelope.security.stdout),
  });
  assert.equal(loadwise(root, 'perf', '--with', 'maint').code, 2);
});

test('changed-only scans use the selected project repository and keep caller-relative paths', (context) => {
  const caller = project(context, {});
  const selected = project(context, { 'tsconfig.json': tsconfig, 'app with spaces.ts': quietSource });
  function git(...args: string[]) {
    const run = spawnSync(
      'git',
      [
        '-C',
        selected,
        '-c',
        'user.name=Loadwise Test',
        '-c',
        'user.email=loadwise@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
  }
  git('init', '-q');
  git('config', 'diff.noprefix', 'true');
  git('add', '--', 'tsconfig.json', 'app with spaces.ts');
  git('commit', '-qm', 'initial files');
  fs.writeFileSync(path.join(selected, 'app with spaces.ts'), slowSource);
  fs.writeFileSync(path.join(selected, 'Dockerfile'), 'FROM node:latest\nUSER node\n');
  git('add', '--', 'app with spaces.ts', 'Dockerfile');
  const relative = (file: string) => path.relative(caller, path.join(selected, file)).split(path.sep).join('/');
  for (const change of [['--staged'], ['--changed-since', 'HEAD']]) {
    const run = loadwise(caller, 'check', selected, '--only', 'perf,sec', '--json', ...change);
    assert.equal(run.code, 1, `${change.join(' ')}\n${run.stderr}\n${run.stdout}`);
    const { performance, security } = JSON.parse(run.stdout);
    assert.equal(performance.findings[0].file, relative('app with spaces.ts'));
    assert.deepEqual(
      security.findings.map(({ file }: Finding) => file),
      [relative('Dockerfile')],
    );
  }
});

test('perf, maint and sec pass their arguments to the full checker CLIs', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const perf = loadwise(root, 'perf', '-p', 'tsconfig.json', '--json');
  assert.equal(perf.code, 1, perf.stderr);
  assert.deepEqual(
    JSON.parse(perf.stdout).findings.map(({ ruleId }: Finding) => ruleId),
    ['array-repeated-membership', 'array-repeated-find', 'reduce-copy-accumulator'],
  );
  assert.match(loadwise(root, 'perf', '--help').stdout, /loadwise perf /);
  assert.match(loadwise(root, 'maint', '--help').stdout, /loadwise maint /);
  assert.match(loadwise(root, 'sec', '--help').stdout, /loadwise sec /);
  assert.equal(loadwise(root, 'sec', '--json').code, 0);
  assert.equal(loadwise(root, 'maint', '.').code, 0);
});

test('--help documents check, every checker command and the selection flags', () => {
  const run = loadwise(os.tmpdir(), '--help');
  assert.equal(run.code, 0);
  for (const text of ['loadwise perf', 'loadwise maint', 'loadwise sec', 'loadwise agent init', '--only', '--skip']) {
    assert.ok(run.stdout.includes(text), text);
  }
});

test('--min-impact reaches the checkers: it filters their findings and an invalid level exits 2', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  assert.equal(loadwise(root, 'check').code, 1);
  const critical = loadwise(root, 'check', '--min-impact', 'critical', '--json');
  assert.equal(critical.code, 0, critical.stderr);
  assert.deepEqual(JSON.parse(critical.stdout).performance.findings, []);
  const invalid = loadwise(root, 'check', '--min-impact', 'severe');
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /--min-impact must be one of/);
});
