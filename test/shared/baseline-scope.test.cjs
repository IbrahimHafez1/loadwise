'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyBaselineOptions } = require('../../lib/shared/baseline.cjs');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const slowSource = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
const secretSource = [
  "import jwt from 'jsonwebtoken';",
  "export const token = (user: string) => jwt.sign({ user }, 'super-secret-key-value');",
  '',
].join('\n');
const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] });
const complexFunction = (name) =>
  [
    `export function ${name}(value) {`,
    ...Array.from({ length: 16 }, (_, index) => `if (value === ${index}) return ${index};`),
    '}',
    '',
  ].join('\n');

function project(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-baseline-scope-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

function loadwise(cwd, ...args) {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

const readBaseline = (root) => JSON.parse(fs.readFileSync(path.join(root, 'loadwise-baseline.json'), 'utf8'));
const recordedFiles = (root, pillar) => [
  ...new Set(readBaseline(root).pillars[pillar].findings.map(({ file }) => file)),
];

test('a write limited to scanned paths keeps entries outside them, a full write drops them', (context) => {
  const root = project(context, {});
  const finding = (file) => ({ ruleId: 'rule', file, id: file.replace(/\W/g, '') });
  const write = (findings, scope) =>
    applyBaselineOptions({
      options: { writeBaseline: {}, scope },
      pillar: 'performance',
      findings,
      projectRoot: root,
      absoluteFileOf: (item) => path.join(root, item.file),
    });
  write([finding('src/a.ts'), finding('lib/b.ts')]);
  write([], { paths: [path.join(root, 'src')] });
  assert.deepEqual(recordedFiles(root, 'performance'), ['lib/b.ts']);
  write([], { paths: [root] });
  assert.deepEqual(recordedFiles(root, 'performance'), []);
});

test('perf --write-baseline on named files keeps the entries of other files', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource, 'b.ts': slowSource });
  assert.equal(loadwise(root, 'perf', '--write-baseline').code, 0);
  const partial = loadwise(root, 'perf', 'a.ts', '--write-baseline');
  assert.equal(partial.code, 0, partial.stderr);
  assert.deepEqual(recordedFiles(root, 'performance'), ['a.ts', 'b.ts']);
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const fine = 1;\n');
  assert.equal(loadwise(root, 'perf', '--write-baseline').code, 0);
  assert.deepEqual(recordedFiles(root, 'performance'), ['a.ts']);
});

test('sec --write-baseline on named files keeps the entries of other files', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': secretSource, 'b.ts': secretSource });
  assert.equal(loadwise(root, 'sec', '--write-baseline').code, 0);
  const partial = loadwise(root, 'sec', 'a.ts', '--write-baseline');
  assert.equal(partial.code, 0, partial.stderr);
  assert.deepEqual(recordedFiles(root, 'security'), ['a.ts', 'b.ts']);
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const fine = 1;\n');
  assert.equal(loadwise(root, 'sec', '--write-baseline').code, 0);
  assert.deepEqual(recordedFiles(root, 'security'), ['a.ts']);
});

test('maint --write-baseline on a subfolder keeps the entries of other folders', (context) => {
  const root = project(context, { 'src/a.ts': complexFunction('dispatch'), 'lib/b.ts': complexFunction('route') });
  const complexityFiles = () =>
    readBaseline(root)
      .pillars.maintainability.findings.filter(({ ruleId }) => ruleId === 'high-branch-complexity')
      .map(({ file }) => file);
  assert.equal(loadwise(root, 'maint', '--write-baseline').code, 0);
  const partial = loadwise(root, 'maint', 'src', '--write-baseline', 'loadwise-baseline.json');
  assert.equal(partial.code, 0, partial.stderr);
  assert.deepEqual(complexityFiles(), ['lib/b.ts', 'src/a.ts']);
  fs.writeFileSync(path.join(root, 'lib/b.ts'), 'export const fine = 1;\n');
  assert.equal(loadwise(root, 'maint', '--write-baseline').code, 0);
  assert.deepEqual(complexityFiles(), ['src/a.ts']);
});

test('a baseline written from the project root matches a maint scan of a subfolder', (context) => {
  const root = project(context, { 'src/a.ts': complexFunction('dispatch'), 'lib/b.ts': complexFunction('route') });
  assert.equal(loadwise(root, 'maint', '--write-baseline').code, 0);
  const fromRoot = JSON.parse(
    loadwise(root, 'maint', 'src', '--json', '--fail-on', 'all', '--baseline', 'loadwise-baseline.json').stdout,
  );
  assert.equal(fromRoot.findings.length, 0);
  const fromSubfolder = JSON.parse(
    loadwise(path.join(root, 'src'), 'maint', '--json', '--fail-on', 'all', '--baseline', '../loadwise-baseline.json')
      .stdout,
  );
  assert.equal(fromSubfolder.findings.length, 0);
  // A partial scan cannot tell which recorded findings are gone.
  assert.equal(fromSubfolder.baselineStale, null);
});

test('a baseline keyed by the old scan-root fingerprint is still read', (context) => {
  const root = project(context, { 'src/a.ts': complexFunction('dispatch') });
  const scanned = JSON.parse(loadwise(root, 'maint', 'src', '--json', '--fail-on', 'all').stdout);
  const legacyEntries = scanned.findings.map(({ ruleId, id }) => ({
    ruleId,
    file: 'src/a.ts',
    fingerprint: id.replace(/-\d+$/, ''),
    count: 1,
  }));
  fs.writeFileSync(
    path.join(root, 'loadwise-baseline.json'),
    JSON.stringify({ version: 1, pillars: { maintainability: { findings: legacyEntries } } }),
  );
  const report = JSON.parse(
    loadwise(root, 'maint', 'src', '--json', '--fail-on', 'all', '--baseline', 'loadwise-baseline.json').stdout,
  );
  assert.deepEqual([report.findings.length, report.baselineHidden], [0, scanned.findings.length]);
});

test('a changed line is still reported against a baseline read from a subfolder', (context) => {
  const root = project(context, { 'src/a.ts': complexFunction('dispatch') });
  assert.equal(loadwise(root, 'maint', '--write-baseline').code, 0);
  fs.writeFileSync(path.join(root, 'src/a.ts'), complexFunction('renamed'));
  const report = JSON.parse(
    loadwise(root, 'maint', 'src', '--json', '--fail-on', 'all', '--baseline', 'loadwise-baseline.json').stdout,
  );
  assert.deepEqual(
    report.findings.map(({ ruleId }) => ruleId),
    ['high-branch-complexity'],
  );
});
