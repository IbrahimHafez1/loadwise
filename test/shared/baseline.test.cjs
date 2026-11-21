'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyBaselineOptions, extractBaselineFlags } = require('../../lib/shared/baseline.cjs');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const slowSource = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] });
const complexFunction = (name) =>
  [
    `export function ${name}(value) {`,
    ...Array.from({ length: 16 }, (_, index) => `if (value === ${index}) return ${index};`),
    '}',
    '',
  ].join('\n');

function project(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-baseline-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}

function loadwise(root, ...args) {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

const maint = (root, ...args) => loadwise(root, 'maint', '--fail-on', 'all', ...args);
const maintJson = (root, ...args) => JSON.parse(maint(root, '--json', ...args).stdout);
const complexityFindings = (report) => report.findings.filter(({ ruleId }) => ruleId === 'high-branch-complexity');
const readBaseline = (root) => JSON.parse(fs.readFileSync(path.join(root, 'loadwise-baseline.json'), 'utf8'));

test('extractBaselineFlags takes an optional .json file and leaves other arguments alone', () => {
  assert.deepEqual(extractBaselineFlags(['src', '--baseline', 'src', '--json']), {
    args: ['src', 'src', '--json'],
    baseline: {},
  });
  assert.deepEqual(extractBaselineFlags(['--write-baseline', 'out/b.json', '-p', 'tsconfig.json']), {
    args: ['-p', 'tsconfig.json'],
    writeBaseline: { file: 'out/b.json' },
  });
  assert.deepEqual(extractBaselineFlags(['--baseline=x.json']), { args: [], baseline: { file: 'x.json' } });
});

test('counts per key allow N copies, report stale entries, and write deterministic sections', (context) => {
  const root = project(context, {});
  const finding = (id, file = 'a.ts') => ({ ruleId: 'rule', file, id });
  const apply = (options, findings) =>
    applyBaselineOptions({
      options,
      pillar: 'performance',
      findings,
      projectRoot: root,
      absoluteFileOf: (item) => path.join(root, item.file),
    });
  apply({ writeBaseline: {} }, [finding('aaa'), finding('aaa-2'), finding('bbb', 'b.ts')]);
  const text = fs.readFileSync(path.join(root, 'loadwise-baseline.json'), 'utf8');
  assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + '\n');
  assert.deepEqual(readBaseline(root).pillars.performance.findings, [
    { ruleId: 'rule', file: 'a.ts', fingerprint: 'aaa', count: 2 },
    { ruleId: 'rule', file: 'b.ts', fingerprint: 'bbb', count: 1 },
  ]);
  const grown = apply({ baseline: {} }, [finding('aaa'), finding('aaa-2'), finding('aaa-3'), finding('bbb', 'b.ts')]);
  assert.deepEqual([grown.hidden, grown.findings.map(({ id }) => id), grown.stale], [3, ['aaa-3'], 0]);
  const fixed = apply({ baseline: {} }, [finding('aaa')]);
  assert.deepEqual([fixed.hidden, fixed.findings.length, fixed.stale], [1, 0, 2]);
});

test('maint --write-baseline then --baseline hides every finding', (context) => {
  const root = project(context, { 'a.ts': complexFunction('dispatch') });
  assert.equal(maint(root).code, 1);
  const written = maint(root, '--write-baseline');
  assert.equal(written.code, 0);
  assert.match(written.stdout, /Wrote 1 finding\(s\) to loadwise-baseline\.json\./);
  const hidden = maint(root, '--baseline');
  assert.equal(hidden.code, 0, hidden.stderr);
  assert.match(hidden.stdout, /^1 baseline findings hidden\.$/m);
  const report = maintJson(root, '--baseline');
  assert.deepEqual([report.findings.length, report.baselineHidden, report.baselineStale], [0, 1, 0]);
});

test('a new finding is reported while the baselined one stays hidden', (context) => {
  const root = project(context, { 'a.ts': complexFunction('dispatch') });
  maint(root, '--write-baseline');
  fs.writeFileSync(path.join(root, 'b.ts'), complexFunction('route'));
  const report = maintJson(root, '--baseline');
  assert.equal(maint(root, '--baseline').code, 1);
  assert.deepEqual(
    complexityFindings(report).map(({ file }) => file),
    ['b.ts'],
  );
});

test('moving the flagged code down ten lines still matches', (context) => {
  const root = project(context, { 'a.ts': complexFunction('dispatch') });
  maint(root, '--write-baseline');
  fs.writeFileSync(path.join(root, 'a.ts'), '// spacer\n'.repeat(10) + complexFunction('dispatch'));
  const report = maintJson(root, '--baseline');
  assert.deepEqual([report.findings.length, report.baselineHidden], [0, 1]);
});

test('duplicate copies are counted: N baselined copies allow N findings', (context) => {
  const root = project(context, { 'a.ts': complexFunction('dispatch') + complexFunction('dispatch') });
  maint(root, '--write-baseline');
  const copiesEntry = readBaseline(root).pillars.maintainability.findings.find(
    ({ ruleId }) => ruleId === 'high-branch-complexity',
  );
  assert.equal(copiesEntry.count, 2);
  fs.appendFileSync(path.join(root, 'a.ts'), complexFunction('dispatch'));
  const newCopies = complexityFindings(maintJson(root, '--baseline'));
  assert.equal(newCopies.length, 1);
});

test('fixed findings are reported as stale and leave the file only on the next --write-baseline', (context) => {
  const root = project(context, { 'a.ts': complexFunction('dispatch') });
  maint(root, '--write-baseline');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const fine = 1;\n');
  const report = maintJson(root, '--baseline');
  assert.deepEqual([report.findings.length, report.baselineHidden, report.baselineStale], [0, 0, 1]);
  assert.match(maint(root, '--baseline').stdout, /1 stale baseline entries/);
  assert.equal(readBaseline(root).pillars.maintainability.findings.length, 1);
  maint(root, '--write-baseline');
  assert.deepEqual(readBaseline(root).pillars.maintainability.findings, []);
});

test('--baseline without a file exits 2, and an explicit file is used as given', (context) => {
  const root = project(context, { 'a.ts': complexFunction('dispatch') });
  const missing = maint(root, '--baseline');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Baseline not found/);
  assert.equal(maint(root, '--write-baseline', 'accepted.json').code, 0);
  assert.equal(maint(root, '--baseline', 'accepted.json').code, 0);
  assert.equal(fs.existsSync(path.join(root, 'loadwise-baseline.json')), false);
});

test('check writes one section per pillar and reads them back', (context) => {
  const root = project(context, {
    'tsconfig.json': tsconfig,
    'a.ts': slowSource,
    'b.ts': complexFunction('dispatch'),
  });
  const written = loadwise(root, 'check', '--write-baseline');
  assert.equal(written.code, 0, written.stderr);
  const { version, pillars } = readBaseline(root);
  assert.equal(version, 1);
  assert.deepEqual(Object.keys(pillars), ['maintainability', 'performance', 'security']);
  assert.equal(
    pillars.performance.findings.reduce((total, { count }) => total + count, 0),
    3,
  );
  assert.equal(pillars.maintainability.findings.length, 1);
  const read = loadwise(root, 'check', '--baseline', '--fail-on', 'all');
  assert.equal(read.code, 0, read.stderr);
  const report = JSON.parse(loadwise(root, 'check', '--baseline', '--json').stdout);
  assert.deepEqual([report.performance.baselineHidden, report.maintainability.baselineHidden], [3, 1]);
});

test('perf reads and writes only its own section', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  assert.equal(loadwise(root, 'perf', '--write-baseline').code, 0);
  assert.deepEqual(Object.keys(readBaseline(root).pillars), ['performance']);
  const run = loadwise(root, 'perf', '--baseline');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /3 baseline findings hidden\./);
});
