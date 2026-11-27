import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { discoverWorkspaces } from '../../lib/shared/workspaces.js';
import type { Finding } from '../../lib/shared/types.js';
import { executable } from '../../lib/performance/native-runtime.js';

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const slowSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/slow.ts'), 'utf8');
const quietSource = 'export function double(value: number) {\n  return value * 2;\n}\n';
const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] });

function monorepo(context: TestContext, files: Readonly<Record<string, string | object>>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-workspaces-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
}

function packageFiles(directory: string, name: string, source = quietSource) {
  return {
    [`${directory}/package.json`]: { name },
    [`${directory}/tsconfig.json`]: tsconfig,
    [`${directory}/index.ts`]: source,
  };
}

function names(root: string) {
  return discoverWorkspaces(root).packages.map(({ name }) => name);
}

function loadwise(root: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('package.json workspaces as an array expands * and nested ** globs', (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['apps/*', 'libs/**'] },
    ...packageFiles('apps/api', 'api'),
    ...packageFiles('libs/shared/deep', 'deep'),
    ...packageFiles('other/ignored', 'ignored'),
  });
  assert.deepEqual(names(root).sort(), ['api', 'deep']);
});

test('package.json workspaces as { packages } is read', (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: { packages: ['pkgs/*'] } },
    ...packageFiles('pkgs/a', 'a'),
  });
  assert.deepEqual(names(root), ['a']);
});

test('pnpm-workspace.yaml lists quoted globs and negations', (context) => {
  const root = monorepo(context, {
    'package.json': { name: 'root' },
    'pnpm-workspace.yaml':
      "# comment\npackages:\n  - 'packages/*'\n  - \"!packages/skip\"\ncatalog:\n  - 'ignored/*'\n",
    ...packageFiles('packages/keep', 'keep'),
    ...packageFiles('packages/skip', 'skip'),
    ...packageFiles('ignored/x', 'x'),
  });
  assert.deepEqual(names(root), ['keep']);
});

test('check scans pnpm packages listed at the same indentation as the packages key', (context) => {
  const root = monorepo(context, {
    'pnpm-workspace.yaml': "packages:\n- 'packages/*'\n- '!packages/skip'\nonlyBuiltDependencies:\n- unrelated\n",
    ...packageFiles('packages/api', 'api', slowSource),
    ...packageFiles('packages/skip', 'skip', slowSource),
    ...packageFiles('unrelated', 'unrelated', slowSource),
  });
  const run = loadwise(root, 'check', '--only', 'perf,sec', '--json');
  assert.equal(run.code, 1, run.stderr);
  const { performance, security } = JSON.parse(run.stdout);
  assert.equal(performance.scannedFiles, 1);
  assert.equal(security.scannedFiles, 1);
  assert.deepEqual([...new Set(performance.findings.map(({ file }: Finding) => file))], ['packages/api/index.ts']);
});

test('invalid workspace manifests explain why discovery could not run', (context) => {
  const root = monorepo(context, { 'package.json': '{"workspaces":', ...packageFiles('packages/api', 'api') });
  const run = loadwise(root, 'check', '--only', 'perf');
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /Invalid JSON in .*package\.json/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: [42] }));
  const invalidPattern = loadwise(root, 'check', '--only', 'perf');
  assert.equal(invalidPattern.code, 2, invalidPattern.stderr);
  assert.match(invalidPattern.stderr, /workspaces.*package\.json.*non-empty strings/);
});

test('unsupported inline pnpm globs exit 2 and explain the supported layout', (context) => {
  const root = monorepo(context, {
    'pnpm-workspace.yaml': "packages: ['packages/*']\n",
    ...packageFiles('packages/api', 'api', slowSource),
  });
  const run = loadwise(root, 'check', '--only', 'perf,sec');
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /pnpm-workspace\.yaml.*own "- pattern" line/);
});

test('explicit workspace selectors report an error when no typed workspace can run', (context) => {
  const root = monorepo(context, { 'package.json': { name: 'plain' }, 'index.ts': quietSource });
  for (const checkers of ['perf', 'sec', 'perf,sec']) {
    const run = loadwise(root, 'check', '--only', checkers, '--workspace', 'missing', '--json');
    assert.equal(run.code, 2, checkers);
    assert.match(run.stderr, /--workspace/);
  }
});

const syncReadSource =
  'const { readFileSync } = require("node:fs");\nmodule.exports = async () => readFileSync("demo");\n';
const findingFiles = (findings: Finding[]) => findings.map(({ file, ruleId }) => `${file} ${ruleId}`);

test('a package without a config is checked with the standalone defaults on both engines', (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    ...packageFiles('packages/typed', 'typed'),
    'packages/plain/package.json': { name: 'plain' },
    'packages/plain/index.js': syncReadSource,
    'packages/bare/package.json': { name: 'bare' },
  });
  assert.deepEqual(
    discoverWorkspaces(root).withoutConfig.map(({ name }) => name),
    ['bare', 'plain'],
  );
  for (const engine of ['js', 'native']) {
    const run = loadwise(root, 'perf', '-p', '.', '--engine', engine, '--json');
    assert.equal(run.code, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(findingFiles(report.findings), ['packages/plain/index.js node-sync-fs-in-async']);
    assert.deepEqual(report.packages.map(({ name }: { name: string }) => name).sort(), ['plain', 'typed']);
    // A package with no sources has nothing to check, so it is not reported as skipped.
    assert.doesNotMatch(run.stderr, /workspace bare/);
  }
  const selected = loadwise(root, 'check', '--only', 'perf,sec', '--workspace', 'plain', '--json');
  assert.equal(selected.code, 1, selected.stderr);
  assert.deepEqual(findingFiles(JSON.parse(selected.stdout).performance.findings), [
    'packages/plain/index.js node-sync-fs-in-async',
  ]);
});

test('a monorepo of packages without configs is checked', (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    'packages/plain/package.json': { name: 'plain' },
    'packages/plain/index.js': syncReadSource,
  });
  const run = loadwise(root, 'check', '--only', 'perf,sec,rel', '--json');
  assert.equal(run.code, 1, run.stderr);
  assert.doesNotMatch(run.stderr, /no tsconfig\.json or jsconfig\.json/);
  assert.deepEqual(findingFiles(JSON.parse(run.stdout).performance.findings), [
    'packages/plain/index.js node-sync-fs-in-async',
  ]);
});

test("a package whose TypeScript sits under a sub-folder's own tsconfig is noted, skipped and blocks fixes", (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    ...packageFiles('packages/typed', 'typed'),
    'packages/nested/package.json': { name: 'nested' },
    'packages/nested/src/tsconfig.json': tsconfig,
    'packages/nested/src/index.ts': slowSource,
  });
  const run = loadwise(root, 'perf', '-p', '.', '--json');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /workspace nested has no tsconfig\.json or jsconfig\.json, and a sub-folder's own/);
  const fix = loadwise(root, 'fix', '--yes', '--only', 'perf');
  assert.equal(fix.code, 2, fix.stderr);
  assert.match(fix.stderr, /missing a source config: nested\. No fixes applied\./);
});

test('check analyses every package once, groups findings per package and keeps cwd-relative paths', (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    ...packageFiles('packages/slow', 'slow-pkg', slowSource),
    ...packageFiles('packages/quiet', 'quiet-pkg'),
  });
  const run = loadwise(root, 'check', '--only', 'perf');
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stdout, /-- slow-pkg \(packages\/slow\) --\npackages\/slow\/index\.ts:\d+:\d+ /);
  assert.doesNotMatch(run.stdout, /quiet-pkg/);
  assert.match(run.stdout, /2 file\(s\) checked, 3 finding\(s\)\./);
});

test('--workspace limits the scan to a package name or path and can repeat', (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    ...packageFiles('packages/slow', 'slow-pkg', slowSource),
    ...packageFiles('packages/quiet', 'quiet-pkg'),
    ...packageFiles('packages/third', 'third-pkg'),
  });
  assert.match(
    loadwise(root, 'perf', '-p', '.', '--workspace', 'quiet-pkg').stdout,
    /^1 file\(s\) checked, 0 finding\(s\)\./,
  );
  const both = loadwise(root, 'perf', '-p', '.', '--workspace', 'packages/quiet', '--workspace', 'slow-pkg');
  assert.match(both.stdout, /-- slow-pkg \(packages\/slow\) --/);
  assert.match(both.stdout, /2 file\(s\) checked, 3 finding\(s\)\./);
  const unknown = loadwise(root, 'perf', '-p', '.', '--workspace', 'missing');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /--workspace missing matches no workspace package/);
});

test('a file included by two packages is reported once', (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    'shared.ts': slowSource,
    'packages/a/package.json': { name: 'a' },
    'packages/a/tsconfig.json': JSON.stringify({ include: ['../../shared.ts'] }),
    'packages/b/package.json': { name: 'b' },
    'packages/b/tsconfig.json': JSON.stringify({ include: ['../../shared.ts'] }),
  });
  const run = loadwise(root, 'perf', '-p', '.', '--json');
  const report = JSON.parse(run.stdout);
  assert.equal(report.scannedFiles, 1);
  assert.equal(report.findings.length, 3);
});

test("a root tsconfig keeps today's behaviour even when workspaces are declared", (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    'tsconfig.json': JSON.stringify({ files: ['root.ts'], references: [{ path: 'packages/a' }] }),
    'root.ts': quietSource,
    'packages/a/package.json': { name: 'a' },
    'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true }, files: ['index.ts'] }),
    'packages/a/index.ts': quietSource,
    ...packageFiles('packages/b', 'b', slowSource),
  });
  const run = loadwise(root, 'check', '--only', 'perf');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^== Performance ==\n2 file\(s\) checked, 0 finding\(s\)\./);
});

test('maint --workspace keeps only the chosen packages, by name or path, in check and maint', (context) => {
  const nested = [
    'export function pick(items: number[][][][]) {',
    '  for (const a of items) {',
    '    for (const b of a) {',
    '      for (const c of b) {',
    '        if (c.length) return c;',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    'packages/a/package.json': { name: 'a' },
    'packages/a/index.ts': nested,
    'packages/b/package.json': { name: 'b' },
    'packages/b/index.ts': nested,
    'packages/c/package.json': { name: 'c' },
    'packages/c/index.ts': quietSource,
  });
  const all = JSON.parse(loadwise(root, 'maint', '.', '--json').stdout);
  const onlyC = JSON.parse(loadwise(root, 'maint', '.', '--json', '--workspace', 'c').stdout);
  assert.equal(onlyC.scannedFiles, 1);
  assert.ok(onlyC.findings.every((finding: Finding) => finding.file?.startsWith('packages/c/')));
  const aAndB = JSON.parse(
    loadwise(root, 'maint', '.', '--json', '--workspace', 'packages/a', '--workspace', 'b').stdout,
  );
  assert.equal(aAndB.scannedFiles, 2);
  assert.ok(aAndB.findings.every((finding: Finding) => /^packages\/[ab]\//.test(finding.file ?? '')));
  assert.ok(all.findings.length > 0, 'fixture must produce maintainability findings');
  assert.equal(aAndB.findings.length, all.findings.length);
  const checked = JSON.parse(loadwise(root, 'check', '--only', 'maint', '--json', '--workspace', 'c').stdout);
  assert.equal(checked.maintainability.scannedFiles, 1);
  assert.equal(loadwise(root, 'maint', '.', '--workspace', 'missing').code, 2);
});

let nativeSkip: string | false = false;
try {
  executable();
} catch {
  nativeSkip = 'optional native compiler is absent';
}

test('two configs on the TypeScript 7 engine report a shared file once', { skip: nativeSkip }, (context) => {
  const root = monorepo(context, {
    'package.json': { workspaces: ['packages/*'] },
    'shared.ts': slowSource,
    'packages/a/package.json': { name: 'a' },
    'packages/a/tsconfig.json': JSON.stringify({ include: ['../../shared.ts'] }),
    'packages/b/package.json': { name: 'b' },
    'packages/b/tsconfig.json': JSON.stringify({ include: ['../../shared.ts'] }),
  });
  const report = JSON.parse(loadwise(root, 'perf', '-p', '.', '--engine', 'native', '--json').stdout);
  assert.equal(report.scannedFiles, 1);
  assert.equal(report.findings.length, 3);
});
