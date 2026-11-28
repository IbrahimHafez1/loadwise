import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

interface SarifResult {
  locations: { physicalLocation: { artifactLocation: { uri: string } } }[];
}

interface SarifReport {
  runs: { results: SarifResult[] }[];
}

const repository = path.resolve(import.meta.dirname, '../..');
const action = path.join(repository, 'action.yml');
const runner = path.join(repository, 'bin/github-action.js');
const stage = path.join(repository, 'scripts/stage-action.js');

function runNode(script: string, args: readonly string[], options: Partial<SpawnSyncOptionsWithStringEncoding> = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function tempDirectory(context: TestContext) {
  const parent = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp/AI-Work') : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'loadwise-action-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(context: TestContext) {
  const directory = tempDirectory(context);
  const project = path.join(directory, 'example app');
  const invocationLog = path.join(directory, 'invocations');
  const outputFile = path.join(directory, 'step-outputs');
  const observerDir = path.join(directory, '.observer');
  const observer = path.join(observerDir, 'observe.cjs');
  fs.mkdirSync(path.join(directory, '.git'));
  fs.mkdirSync(project);
  fs.mkdirSync(observerDir);
  fs.writeFileSync(path.join(observerDir, 'package.json'), '{"type":"commonjs"}\n');
  fs.writeFileSync(
    observer,
    "if (require('node:path').basename(process.argv[1] ?? '') === 'loadwise.js') {\n" +
      "  require('node:fs').appendFileSync(process.env.LOADWISE_TEST_INVOCATIONS, process.argv[2] + '\\n');\n" +
      '}\n',
  );
  fs.copyFileSync(path.join(repository, 'examples/slow.ts'), path.join(project, 'slow.ts'));
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{"include":["*.ts"]}');
  return {
    project,
    run(overrides: Record<string, string> = {}) {
      const result = runNode(runner, [], {
        cwd: directory,
        env: {
          ...process.env,
          NODE_OPTIONS: `--require "${observer.replaceAll('\\', '/')}"`,
          LOADWISE_TEST_INVOCATIONS: invocationLog,
          GITHUB_OUTPUT: outputFile,
          RUNNER_TEMP: directory,
          LOADWISE_CHECKERS: 'perf',
          LOADWISE_PATH: 'example app',
          LOADWISE_CHANGED_ONLY: 'false',
          LOADWISE_BASE_SHA: '',
          LOADWISE_FAIL_ON: '',
          LOADWISE_UPLOAD_SARIF: 'true',
          LOADWISE_ANNOTATIONS: 'true',
          ...overrides,
        },
      });
      const outputs = Object.fromEntries(
        fs
          .readFileSync(outputFile, 'utf8')
          .trim()
          .split(/\r?\n/)
          .map((line) => line.split(/=(.*)/).slice(0, 2)),
      );
      const invocations = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, 'utf8').trim().split('\n') : [];
      return { ...result, outputs, invocations };
    },
  };
}

test('the action installs locked dependencies for its own source in a fresh runner directory', (context) => {
  const temp = tempDirectory(context);
  const runtime = runNode(stage, [], { env: { ...process.env, RUNNER_TEMP: temp } }).stdout.trim();
  assert.equal(path.dirname(runtime), temp);
  assert.deepEqual(
    fs.readFileSync(path.join(runtime, 'package-lock.json')),
    fs.readFileSync(path.join(repository, 'package-lock.json')),
  );
  assert.ok(fs.existsSync(path.join(runtime, 'bin/github-action.js')));
  assert.ok(fs.existsSync(path.join(runtime, 'lib/shared/check.js')));
  assert.ok(!fs.existsSync(path.join(runtime, 'node_modules')));
  const metadata = fs.readFileSync(action, 'utf8');
  assert.match(metadata, /npm --prefix "\$runtime" ci --omit=dev/);
  assert.match(metadata, /sarif_file: \$\{\{ steps\.loadwise\.outputs\.sarif-file \}\}/);
  assert.doesNotMatch(metadata, /npx|hashFiles/);
});

test('one report produces SARIF and annotations while preserving a findings exit code', (context) => {
  const { stdout, outputs, invocations } = fixture(context).run();
  assert.equal(outputs['exit-code'], '1');
  assert.deepEqual(invocations, ['perf']);
  assert.match(stdout, /^::warning file=example app\/slow\.ts,line=\d+,col=\d+,title=/m);
  const sarif: SarifReport = JSON.parse(fs.readFileSync(outputs['sarif-file'] ?? '', 'utf8'));
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].results.length, stdout.trim().split('\n').length);
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'example%20app/slow.ts');
});

test('the action respects text-only output and the contract threshold', (context) => {
  const { stdout, outputs, invocations } = fixture(context).run({
    LOADWISE_UPLOAD_SARIF: 'false',
    LOADWISE_ANNOTATIONS: 'false',
    LOADWISE_FAIL_ON: 'contract',
  });
  assert.deepEqual(outputs, { 'exit-code': '0' });
  assert.deepEqual(invocations, ['perf']);
  assert.match(stdout, /^== Performance ==/m);
  assert.doesNotMatch(stdout, /^::warning/m);
});

test('invalid options report exit code 2 and no SARIF to upload', (context) => {
  const { stderr, outputs, invocations } = fixture(context).run({ LOADWISE_CHECKERS: 'unknown' });
  assert.match(stderr, /Unknown --only name/);
  assert.deepEqual(outputs, { 'exit-code': '2' });
  assert.deepEqual(invocations, []);
});

test('a checker failure preserves its exit code and withholds incomplete SARIF', (context) => {
  const actionRun = fixture(context);
  fs.writeFileSync(path.join(actionRun.project, 'tsconfig.json'), '{');
  const { outputs } = actionRun.run({ LOADWISE_CHECKERS: 'perf,maint' });
  assert.deepEqual(outputs, { 'exit-code': '2' });
});

test('a skipped checker exits successfully without scheduling an empty SARIF upload', (context) => {
  const actionRun = fixture(context);
  const directory = path.join(actionRun.project, 'docs');
  fs.mkdirSync(directory);
  const { outputs } = actionRun.run({ LOADWISE_PATH: directory });
  assert.deepEqual(outputs, { 'exit-code': '0' });
});

test('a completed clean scan uploads its empty results', (context) => {
  const actionRun = fixture(context);
  fs.writeFileSync(path.join(actionRun.project, 'slow.ts'), 'export const version = 1;\n');
  const { outputs } = actionRun.run();
  assert.equal(outputs['exit-code'], '0');
  const sarif: SarifReport = JSON.parse(fs.readFileSync(outputs['sarif-file'] ?? '', 'utf8'));
  assert.deepEqual(
    sarif.runs.map(({ results }) => results),
    [[]],
  );
});

test('the action stages and compiles an unbuilt git checkout without devDependencies', (context) => {
  const source = tempDirectory(context);
  const runnerTemp = tempDirectory(context);
  const copySource = (relative: string) => {
    const origin = path.join(repository, relative);
    const destination = path.join(source, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(origin, destination, {
      recursive: true,
      filter: (entry) => {
        const rel = path.relative(repository, entry).split(path.sep).join('/');
        if (rel.startsWith('lib/performance/vendor/')) return true;
        return !entry.endsWith('.js') && !entry.endsWith('.cjs');
      },
    });
  };
  for (const entry of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'PERFORMANCE.md',
    'LICENSE',
    'bin',
    'lib',
    'plugin',
    'polyglot',
    'schema',
    'examples',
    'scripts/stage-action.ts',
  ]) {
    copySource(entry);
  }
  const runtime = runNode(path.join(source, 'scripts/stage-action.ts'), [], {
    env: { ...process.env, RUNNER_TEMP: runnerTemp },
  }).stdout.trim();
  assert.equal(path.dirname(runtime), runnerTemp);
  assert.ok(!fs.existsSync(path.join(runtime, 'bin/github-action.js')));
  assert.ok(fs.existsSync(path.join(runtime, 'tsconfig.json')));
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(runtime, 'node_modules'), 'junction');
  const tsc = path.join(repository, 'node_modules/typescript/bin/tsc');
  runNode(tsc, ['-p', path.join(runtime, 'tsconfig.json'), '--noCheck']);
  assert.ok(fs.existsSync(path.join(runtime, 'bin/github-action.js')));
  assert.ok(fs.existsSync(path.join(runtime, 'lib/shared/check.js')));
});
