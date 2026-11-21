'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const slowSource = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
const quietSource = 'export function double(value: number) {\n  return value * 2;\n}\n';
const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] });

function project(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-check-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}

function loadwise(root, ...args) {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('plain loadwise checks the current folder with every checker in titled sections', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': quietSource });
  const run = loadwise(root);
  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stdout,
    /^== Performance ==\n1 file\(s\) checked, 0 finding\(s\)\.\n== Maintainability ==\n.*\n== Security ==\n1 file\(s\) checked, 0 finding\(s\)\.\n$/,
  );
  assert.deepEqual(loadwise(root, 'check', '.'), run);
});

test('a performance finding exits 1 and prints the per-checker fix command instead of fixing', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const run = loadwise(root, 'check');
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stdout, /Fix all: npx loadwise perf -p tsconfig\.json --fix --only [0-9a-f,]+\n/);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), slowSource);
});

test('--json prints one key per checker', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const run = loadwise(root, '--json');
  const report = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(report), ['performance', 'maintainability', 'security']);
  assert.equal(report.performance.findings.length, 3);
  assert.deepEqual(report.maintainability.findings, []);
  assert.deepEqual(report.security.findings, []);
});

test('one checker with invalid configuration makes check exit 2 and its JSON report null', (context) => {
  const root = project(context, {
    'tsconfig.json': tsconfig,
    'a.ts': slowSource,
    'maintainability.config.json': '{broken',
  });
  const run = loadwise(root, '--json');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Invalid JSON in .*maintainability\.config\.json/);
  const report = JSON.parse(run.stdout);
  assert.equal(report.maintainability, null);
  assert.equal(report.performance.findings.length, 3);
});

test('without a tsconfig or jsconfig the performance and security checkers are skipped with a note', (context) => {
  const root = project(context, { 'a.ts': quietSource });
  const run = loadwise(root, '--json');
  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stderr,
    /no tsconfig\.json or jsconfig\.json in .*; skipped the performance and security checkers\./,
  );
  assert.equal(JSON.parse(run.stdout).performance, null);
  assert.equal(JSON.parse(run.stdout).security, null);
});

test('--only and --skip select checkers, and --json keys follow the selection', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const keys = (...args) => Object.keys(JSON.parse(loadwise(root, '--json', ...args).stdout));
  assert.deepEqual(keys('--only', 'maint'), ['maintainability']);
  assert.deepEqual(keys('--only', 'maint,perf,maint'), ['performance', 'maintainability']);
  assert.deepEqual(keys('--skip', 'perf'), ['maintainability', 'security']);
  assert.deepEqual(keys('--only', 'sec'), ['security']);
  assert.deepEqual(keys('--skip', 'sec'), ['performance', 'maintainability']);
  const maintOnly = loadwise(root, '--only', 'maint');
  assert.equal(maintOnly.code, 0, 'the performance findings are not checked');
  assert.doesNotMatch(maintOnly.stdout, /== Performance ==/);
});

test('invalid checker selections exit 2 and name the valid checkers', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': quietSource });
  const unknown = loadwise(root, '--only', 'perf,lint');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown --only name "lint"; use perf, maint, sec\./);
  const both = loadwise(root, '--only', 'perf', '--skip', 'maint');
  assert.equal(both.code, 2);
  assert.match(both.stderr, /Choose either --only or --skip\./);
  assert.equal(loadwise(root, '--skip', 'perf,maint,sec').code, 2);
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
  function git(...args) {
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
  const relative = (file) => path.relative(caller, path.join(selected, file)).split(path.sep).join('/');
  for (const change of [['--staged'], ['--changed-since', 'HEAD']]) {
    const run = loadwise(caller, 'check', selected, '--only', 'perf,sec', '--json', ...change);
    assert.equal(run.code, 1, `${change.join(' ')}\n${run.stderr}\n${run.stdout}`);
    const { performance, security } = JSON.parse(run.stdout);
    assert.equal(performance.findings[0].file, relative('app with spaces.ts'));
    assert.deepEqual(
      security.findings.map(({ file }) => file),
      [relative('Dockerfile')],
    );
  }
});

test('perf, maint and sec pass their arguments to the full checker CLIs', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const perf = loadwise(root, 'perf', '-p', 'tsconfig.json', '--json');
  assert.equal(perf.code, 1, perf.stderr);
  assert.deepEqual(
    JSON.parse(perf.stdout).findings.map(({ ruleId }) => ruleId),
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

test('--min-impact reaches both checkers: it filters their findings and an invalid level exits 2', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  assert.equal(loadwise(root, 'check').code, 1);
  const critical = loadwise(root, 'check', '--min-impact', 'critical', '--json');
  assert.equal(critical.code, 0, critical.stderr);
  assert.deepEqual(JSON.parse(critical.stdout).performance.findings, []);
  const invalid = loadwise(root, 'check', '--min-impact', 'severe');
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /--min-impact must be one of/);
});
