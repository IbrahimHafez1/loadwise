'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { keepChangedFindings, parseChangedLines, fileKey } = require('../../lib/performance/changed-lines.cjs');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const slowExample = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
const directory = path.resolve('project');

function inDirectory(relative) {
  return fileKey(path.join(directory, relative));
}

test('diff parsing records new-side ranges, whole added files and ignores deletions', () => {
  const diff = [
    'diff --git a/added.ts b/added.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/added.ts',
    '@@ -0,0 +1,3 @@',
    '+one',
    'diff --git a/src/edited.ts b/src/edited.ts',
    '--- a/src/edited.ts',
    '+++ b/src/edited.ts',
    '@@ -4,2 +4,0 @@',
    '-deleted',
    '@@ -10 +8 @@',
    '+single',
    '@@ -20,0 +21,2 @@',
    '+two',
    'diff --git a/old.ts b/renamed.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to renamed.ts',
    '--- a/old.ts',
    '+++ b/renamed.ts',
    '@@ -1 +1,2 @@',
    '+edit',
  ].join('\n');
  const changed = parseChangedLines(diff, directory);
  assert.deepEqual(changed.get(inDirectory('added.ts')), [[1, 3]]);
  assert.deepEqual(changed.get(inDirectory('src/edited.ts')), [
    [8, 8],
    [21, 22],
  ]);
  assert.deepEqual(changed.get(inDirectory('renamed.ts')), [[1, 2]]);
  assert.equal(changed.has(inDirectory('old.ts')), false);
});

test('findings are kept only when their line range overlaps a changed range', () => {
  const changedLines = new Map([[inDirectory('a.ts'), [[10, 12]]]]);
  const findings = [
    { file: 'a.ts', line: 9 },
    { file: 'a.ts', line: 11 },
    { file: 'a.ts', line: 8, endLine: 10 },
    { file: 'a.ts', line: 13, endLine: 20 },
    { file: 'b.ts', line: 11 },
  ];
  const kept = keepChangedFindings(findings, changedLines, directory);
  assert.deepEqual(kept, [findings[1], findings[2]]);
});

function gitRepository(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-changed-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
  );
  fs.writeFileSync(path.join(root, 'other.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'slow.ts'), slowExample);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const run = (...args) => spawnSync(process.execPath, [bin, 'perf', ...args], { cwd: root, encoding: 'utf8' });
  return { root, git, run };
}

test('--staged exits before loading TypeScript when nothing is staged', (context) => {
  const { run } = gitRepository(context);
  const result = run('--staged', '--json');
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { scannedFiles: 0, findings: [] });
  assert.equal(run('--staged').stdout.trim(), 'No changed JavaScript or TypeScript files.');
});

test('--staged ignores findings on unchanged lines and prints fix and dismiss commands for changed ones', (context) => {
  const { root, git, run } = gitRepository(context);
  fs.appendFileSync(path.join(root, 'other.ts'), 'export const next = 2;\n');
  git('add', 'other.ts');
  const quiet = run('--staged', '-p', 'tsconfig.json', '--engine', 'js');
  assert.equal(quiet.status, 0);
  assert.match(quiet.stdout, /No new findings in changed lines/);

  const slowFile = path.join(root, 'slow.ts');
  fs.writeFileSync(
    slowFile,
    slowExample.replace('allowed.includes(order.customerId)', 'allowed.includes(order.customerId) || false'),
  );
  git('add', 'slow.ts');
  const noisy = run('--staged', '-p', 'tsconfig.json', '--engine', 'js');
  assert.equal(noisy.status, 1);
  assert.match(noisy.stdout, /^slow\.ts:\d+ \[[a-z-]+ #[0-9a-f]{12}\] /m);
  assert.match(noisy.stdout, /dismiss: \/\/ warden-reviewed [a-z-]+ -- <reason>/);
  assert.match(
    noisy.stdout,
    /\d+ new finding\(s\) in changed lines\. Apply fixes, then `git add` the files and commit again\./,
  );
  const json = JSON.parse(run('--staged', '-p', 'tsconfig.json', '--engine', 'js', '--json').stdout);
  assert.ok(json.findings.length > 0);
  assert.ok(json.findings.every(({ file }) => file === 'slow.ts'));
});

test('--changed-since compares the working tree with a ref', (context) => {
  const { root, git, run } = gitRepository(context);
  fs.writeFileSync(path.join(root, 'fresh.ts'), slowExample);
  const result = run('--changed-since', 'HEAD', '-p', 'tsconfig.json', '--engine', 'js', '--json');
  assert.equal(result.status, 1);
  const files = new Set(JSON.parse(result.stdout).findings.map(({ file }) => file));
  assert.deepEqual([...files], ['fresh.ts']);
  assert.equal(git('status', '--short').stdout.includes('fresh.ts'), true);
});

test('--staged rejects explicit files and a missing git repository', (context) => {
  const { root, run } = gitRepository(context);
  assert.equal(run('--staged', 'slow.ts').status, 2);
  assert.equal(run('--staged', '--changed-since', 'HEAD').status, 2);
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  assert.equal(run('--staged').status, 2);
});
