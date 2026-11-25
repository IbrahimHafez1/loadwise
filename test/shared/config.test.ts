import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSettings } from '../../lib/shared/config.js';
import { registeredRuleIds } from '../../lib/shared/pillars.js';
import type { Finding } from '../../lib/shared/types.js';
import type { TestContext } from 'node:test';
import type { JsonFileMap } from '../types/project-files.js';

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const slowSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/slow.ts'), 'utf8');
const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['**/*.ts'] });
const perfRules = ['array-repeated-membership', 'array-repeated-find', 'reduce-copy-accumulator'];
const placement = { placement: [{ suffix: '.ts', under: ['lib'] }] };

function project(context: TestContext, files: JsonFileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-config-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
}

function loadwise(root: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function perfRun(root: string, ...args: string[]) {
  const run = loadwise(root, 'perf', '-p', 'tsconfig.json', '--json', ...args);
  const findings = run.stdout ? JSON.parse(run.stdout).findings : [];
  return { ...run, findings, ruleIds: findings.map((finding: Finding) => finding.ruleId) };
}

// The fixtures are lone modules nothing imports, which unreferenced-file would report in every
// test.
const skipUnreferenced = ['--ignore', 'unreferenced-file'];

function maintFindings(root: string, ...args: string[]) {
  return JSON.parse(loadwise(root, 'maint', '.', '--json', ...skipUnreferenced, ...args).stdout).findings;
}

// Findings in the tests are relative to the config's folder, as they are for a checker run from the
// project root.
function applySettings(context: TestContext, config: object, findings: Finding[], ignore?: readonly string[]) {
  const directory = project(context, { 'loadwise.config.json': config });
  return loadSettings({ directory, ignore }).apply(findings, directory);
}

function findingsIn(...files: string[]): Finding[] {
  return files.map((file) => ({ file, ruleId: 'pg-query-in-loop', message: 'slow' }));
}

test('rules off drops a rule, warn keeps it without failing, error keeps it', (context) => {
  const base = { 'tsconfig.json': tsconfig, 'a.ts': slowSource };
  const off = project(context, { ...base, 'loadwise.config.json': { rules: { [perfRules[0]]: 'off' } } });
  assert.deepEqual(perfRun(off).ruleIds, perfRules.slice(1));

  const allWarn = Object.fromEntries(perfRules.map((id) => [id, 'warn']));
  const warnAll = project(context, { ...base, 'loadwise.config.json': { rules: allWarn } });
  const warned = perfRun(warnAll);
  assert.equal(warned.code, 0, warned.stderr);
  assert.equal(warned.ruleIds.length, 3);
  assert.match(loadwise(warnAll, 'perf', '-p', 'tsconfig.json').stdout, /3 finding\(s\) are warnings/);

  const objectForm = project(context, {
    ...base,
    'loadwise.config.json': { rules: { [perfRules[0]]: { level: 'off' } } },
  });
  assert.equal(perfRun(objectForm).ruleIds.includes(perfRules[0]), false);
});

test('error counts under --fail-on contract while plain findings do not', (context) => {
  const base = { 'tsconfig.json': tsconfig, 'a.ts': slowSource };
  const ordinary = perfRun(project(context, base), '--fail-on', 'contract');
  assert.equal(ordinary.code, 0, ordinary.stderr);
  const promoted = project(context, { ...base, 'loadwise.config.json': { rules: { [perfRules[1]]: 'error' } } });
  const enforced = perfRun(promoted, '--fail-on', 'contract');
  assert.equal(enforced.code, 1, enforced.stderr);
});

test('ignore excludes paths from every checker and overrides change rules for matching files', (context) => {
  const root = project(context, {
    'tsconfig.json': tsconfig,
    'src/a.ts': slowSource,
    'generated/b.ts': slowSource,
    'src/legacy/c.ts': slowSource,
    'loadwise.config.json': {
      ignore: ['generated/**'],
      overrides: [{ files: ['src/legacy/**'], rules: { [perfRules[0]]: 'off' } }],
    },
  });
  const { findings } = perfRun(root);
  const idsIn = (file: string) =>
    findings.filter((finding: Finding) => finding.file === file).map((finding: Finding) => finding.ruleId);
  assert.equal(
    findings.some((finding: Finding) => finding.file?.startsWith('generated/')),
    false,
  );
  assert.deepEqual(idsIn('src/a.ts'), perfRules);
  assert.deepEqual(idsIn('src/legacy/c.ts'), perfRules.slice(1));
});

test('the ignore globs match folders, star, double star, question marks and braces', (context) => {
  const config = { ignore: ['generated', 'src/*.gen.ts', 'tools/**/x?.ts', 'lib/{a,b}/**'] };
  const kept = findingsIn('src/main.ts', 'src/deep/main.gen.ts', 'tools/x12.ts', 'lib/c/z.ts');
  const dropped = findingsIn('generated/a.ts', 'src/main.gen.ts', 'tools/x1.ts', 'tools/a/b/xy.ts', 'lib/a/z.ts');
  assert.deepEqual(applySettings(context, config, [...kept, ...dropped]), kept);
});

test('later overrides win and --ignore beats the config', (context) => {
  const config = {
    rules: { 'pg-query-in-loop': 'warn' },
    overrides: [
      { files: ['src/**'], rules: { 'pg-query-in-loop': 'error' } },
      { files: ['src/skip/**'], rules: { 'pg-query-in-loop': 'off' } },
    ],
  };
  const findings: Finding[] = [
    ...findingsIn('other.ts', 'src/a.ts', 'src/skip/b.ts'),
    { file: 'src/a.ts', ruleId: 'prisma-query-in-loop', message: 'slow' },
  ];
  const applied = applySettings(context, config, findings, ['prisma-query-in-loop']);
  assert.deepEqual(
    applied.map(({ file, level }) => [file, level]),
    [
      ['other.ts', 'warn'],
      ['src/a.ts', 'error'],
    ],
  );
});

test('check uses the config checkers unless --only or --skip is given', (context) => {
  const root = project(context, {
    'tsconfig.json': tsconfig,
    'a.ts': 'export const one = 1;\n',
    'loadwise.config.json': { checkers: ['maint'] },
  });
  assert.match(loadwise(root).stdout, /^== Maintainability ==/);
  assert.match(loadwise(root, '--only', 'perf').stdout, /^== Performance ==/);
  const skipped = loadwise(root, '--skip', 'maint').stdout;
  assert.match(skipped, /^== Performance ==/);
  assert.doesNotMatch(skipped, /Maintainability/);
});

test('check --ignore reaches only the checker that owns the rule', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const run = loadwise(root, 'check', '--ignore', 'array-repeated-find', '--ignore', 'folder-boundary', '--json');
  assert.equal(run.code, 1, run.stderr);
  const ids = JSON.parse(run.stdout).performance.findings.map((finding: Finding) => finding.ruleId);
  assert.deepEqual(ids, ['array-repeated-membership', 'reduce-copy-accumulator']);
});

test('--config names another file and a missing one exits 2', (context) => {
  const root = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource, 'other.json': { ignore: ['a.ts'] } });
  const run = loadwise(root, 'check', '--config', 'other.json', '--only', 'perf');
  assert.equal(run.code, 0, run.stderr);
  const missing = loadwise(root, 'check', '--config', 'nope.json');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Cannot find config file .*nope\.json/);
});

test('the performance section replaces backend-perf.policy.json and notes when both exist', (context) => {
  const policy = { parallelReads: [{ from: '@app/reads', exports: ['fetchUser', 'fetchPosts'] }] };
  const source = [
    "import { fetchUser, fetchPosts } from '@app/reads';",
    'export async function load(id: string) {',
    '  const user = await fetchUser(id);',
    '  const posts = await fetchPosts(id);',
    '  return { user, posts };',
    '}',
    '',
  ].join('\n');
  const readsTsconfig = JSON.stringify({
    compilerOptions: {
      strict: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      paths: { '@app/reads': ['./reads.ts'] },
    },
    include: ['**/*.ts'],
  });
  const reads = [
    'export async function fetchUser(id: string) { return { id }; }',
    'export async function fetchPosts(id: string) { return [id]; }',
    '',
  ].join('\n');
  const files = { 'tsconfig.json': readsTsconfig, 'reads.ts': reads, 'a.ts': source };
  const legacyIds = perfRun(project(context, { ...files, 'backend-perf.policy.json': policy })).ruleIds;
  assert.ok(legacyIds.length > 0, 'the legacy policy produces a finding');
  assert.deepEqual(
    perfRun(project(context, { ...files, 'loadwise.config.json': { performance: policy } })).ruleIds,
    legacyIds,
  );

  const both = project(context, {
    ...files,
    'backend-perf.policy.json': { parallelReads: [] },
    'loadwise.config.json': { performance: policy },
  });
  const run = perfRun(both);
  assert.deepEqual(run.ruleIds, legacyIds);
  assert.match(run.stderr, /has a "performance" section; ignoring .*backend-perf\.policy\.json/);

  const broken = project(context, { ...files, 'loadwise.config.json': { performance: { nope: 1 } } });
  assert.match(perfRun(broken).stderr, /Cannot load the "performance" section/);
});

test('the maintainability section replaces maintainability.config.json and --config still wins', (context) => {
  const files = { 'src/a.ts': 'export const one = 1;\n', 'other/b.ts': 'export const two = 2;\n' };
  const legacy = project(context, { ...files, 'maintainability.config.json': placement });
  const legacyFindings = maintFindings(legacy);
  assert.ok(legacyFindings.some((finding: Finding) => finding.ruleId === 'file-placement'));

  const sectioned = project(context, { ...files, 'loadwise.config.json': { maintainability: placement } });
  assert.equal(maintFindings(sectioned).length, legacyFindings.length);

  const both = project(context, {
    ...files,
    'maintainability.config.json': placement,
    'loadwise.config.json': { maintainability: { exclude: ['src'] } },
  });
  assert.deepEqual(maintFindings(both), []);
  assert.match(loadwise(both, 'maint', '.', '--json').stderr, /has a "maintainability" section; ignoring/);
  assert.equal(maintFindings(both, '--config', 'maintainability.config.json').length, legacyFindings.length);
});

test('maint applies off, warn and --ignore to its findings', (context) => {
  const files = { 'src/a.ts': 'export const one = 1;\n', 'maintainability.config.json': placement };
  assert.equal(loadwise(project(context, files), 'maint', '.', ...skipUnreferenced).code, 1);
  const warn = project(context, { ...files, 'loadwise.config.json': { rules: { 'file-placement': 'warn' } } });
  const warned = loadwise(warn, 'maint', '.', ...skipUnreferenced);
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stdout, /1 finding\(s\) are warnings/);
  const off = project(context, { ...files, 'loadwise.config.json': { rules: { 'file-placement': 'off' } } });
  assert.match(loadwise(off, 'maint', '.', ...skipUnreferenced).stdout, /0 finding\(s\)/);
  const ignored = loadwise(project(context, files), 'maint', '.', '--ignore', 'file-placement', ...skipUnreferenced);
  assert.match(ignored.stdout, /0 finding\(s\)/);
});

test('invalid configuration exits 2 and names every bad key', (context) => {
  const root = project(context, {
    'tsconfig.json': tsconfig,
    'a.ts': 'export const one = 1;\n',
    'loadwise.config.json': {
      colour: true,
      checkers: ['perf', 'lint'],
      ignore: [''],
      rules: { 'no-such-rule': 'off', 'pg-query-in-loop': 'loud', 'prisma-query-in-loop': { level: 'warn', depth: 2 } },
      overrides: [{ files: [], rules: {}, extra: 1 }],
      performance: [],
    },
  });
  const mentions = [
    '"colour"',
    '"lint"',
    'ignore must',
    '"no-such-rule"',
    'pg-query-in-loop needs a level',
    '"depth"',
    'overrides[0].files',
    '"extra"',
    'performance must',
  ];
  for (const args of [['check'], ['perf', '-p', 'tsconfig.json'], ['maint', '.']]) {
    const run = loadwise(root, ...args);
    assert.equal(run.code, 2, args.join(' '));
    for (const text of mentions)
      assert.ok(run.stderr.includes(text), `${args[0]} stderr mentions ${text}: ${run.stderr}`);
  }
  const broken = project(context, { 'loadwise.config.json': '{nope' });
  assert.match(loadwise(broken, 'check').stderr, /Invalid JSON in .*loadwise\.config\.json/);
  assert.equal(loadwise(project(context, { 'loadwise.config.json': '[]' }), 'check').code, 2);
  const unknownIgnore = loadwise(project(context, {}), 'check', '--ignore', 'no-such-rule');
  assert.equal(unknownIgnore.code, 2);
  assert.match(unknownIgnore.stderr, /Unknown rule id: no-such-rule/);
});

test('the shipped schema lists exactly the registered rule ids and config keys', () => {
  const schemaFile = path.resolve(import.meta.dirname, '../../schema/loadwise.config.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  const ruleIds = [...registeredRuleIds()].sort();
  assert.deepEqual([...schema.properties.rules.propertyNames.enum].sort(), ruleIds);
  assert.deepEqual([...schema.properties.overrides.items.properties.rules.propertyNames.enum].sort(), ruleIds);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    '$schema',
    'checkers',
    'ignore',
    'maintainability',
    'overrides',
    'performance',
    'rules',
  ]);
});

const duplicatedBody = `{
  const cleaned = input.trim();
  if (!cleaned || cleaned.length > 20) return fallback;
  const pieces = cleaned.split("-");
  return pieces.map(piece => piece.toLowerCase()).join("_");
}`;
const duplicatedFunction = (name: string) =>
  `export function ${name}(input: string, fallback: string) ${duplicatedBody}\n`;

test('maint leaves ignored files out of discovery, so they are not counted or compared', (context) => {
  const files = {
    'src/a.ts': duplicatedFunction('one'),
    'copy/b.ts': duplicatedFunction('two'),
    'src/c.ts': 'export const three = 3;\n',
  };
  const plain = JSON.parse(loadwise(project(context, files), 'maint', '.', '--json', ...skipUnreferenced).stdout);
  assert.ok(plain.findings.some((finding: Finding) => finding.ruleId === 'duplicate-implementation'));
  const ignored = project(context, { ...files, 'loadwise.config.json': { ignore: ['copy/**'] } });
  const report = JSON.parse(loadwise(ignored, 'maint', '.', '--json', ...skipUnreferenced).stdout);
  assert.deepEqual(report.findings, []);
  assert.equal(report.scannedFiles, plain.scannedFiles - 1);
});

test('perf leaves ignored files out of the scan, so they are not counted', (context) => {
  const base = { 'tsconfig.json': tsconfig, 'src/a.ts': slowSource, 'generated/b.ts': slowSource };
  const plain = JSON.parse(perfRun(project(context, base)).stdout);
  const ignored = project(context, { ...base, 'loadwise.config.json': { ignore: ['generated'] } });
  const report = JSON.parse(perfRun(ignored).stdout);
  assert.equal(report.scannedFiles, plain.scannedFiles - 1);
  assert.equal(
    report.findings.some((finding: Finding) => finding.file?.startsWith('generated/')),
    false,
  );
});

test('perf notes when the ignore globs leave no files to check', (context) => {
  const root = project(context, {
    'tsconfig.json': tsconfig,
    'src/a.ts': slowSource,
    'loadwise.config.json': { ignore: ['src'] },
  });
  const run = perfRun(root);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.findings, []);
  assert.match(
    run.stderr,
    /every source file matches "ignore" in .*loadwise\.config\.json; no files were left to check/,
  );
});

test('a repeated key in the config exits 2, including inside the performance section', (context) => {
  const text = '{"performance":{"parallelReads":[],"parallelReads":[]}}';
  const run = loadwise(project(context, { 'loadwise.config.json': text }), 'check');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Duplicate config key/);
});
