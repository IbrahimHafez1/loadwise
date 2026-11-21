'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repository = path.resolve(__dirname, '../..');
const action = path.join(repository, 'action.yml');
const runner = path.join(repository, 'bin/github-action.cjs');
const stage = path.join(repository, 'scripts/stage-action.cjs');

function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function tempDirectory(context) {
  const parent = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp/AI-Work') : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'loadwise-action-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(context) {
  const directory = tempDirectory(context);
  const project = path.join(directory, 'example app');
  const invocationLog = path.join(directory, 'invocations');
  const outputFile = path.join(directory, 'step-outputs');
  const observer = path.join(directory, 'observe.cjs');
  fs.mkdirSync(path.join(directory, '.git'));
  fs.mkdirSync(project);
  fs.writeFileSync(
    observer,
    "if (require('node:path').basename(process.argv[1] ?? '') === 'loadwise.cjs') {\n" +
      "  require('node:fs').appendFileSync(process.env.LOADWISE_TEST_INVOCATIONS, process.argv[2] + '\\n');\n" +
      '}\n',
  );
  fs.copyFileSync(path.join(repository, 'examples/slow.ts'), path.join(project, 'slow.ts'));
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{"include":["*.ts"]}');
  return {
    project,
    run(overrides = {}) {
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
  assert.ok(fs.existsSync(path.join(runtime, 'bin/github-action.cjs')));
  assert.ok(fs.existsSync(path.join(runtime, 'lib/shared/check.cjs')));
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
  const sarif = JSON.parse(fs.readFileSync(outputs['sarif-file'], 'utf8'));
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
  const sarif = JSON.parse(fs.readFileSync(outputs['sarif-file'], 'utf8'));
  assert.deepEqual(
    sarif.runs.map(({ results }) => results),
    [[]],
  );
});
