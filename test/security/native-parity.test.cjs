'use strict';

// The security checker must report the same findings under the TypeScript 7 native engine and the JS engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
let nativeSkip = nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!nativeSkip) require('../../lib/performance/native-runtime.cjs').executable();
} catch {
  nativeSkip = 'optional native compiler is absent';
}

const files = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, esModuleInterop: true },
    files: ['app.ts', 'helper.ts'],
  }),
  // The sink sits behind a helper, so the finding needs the interprocedural summary.
  'helper.ts': [
    "import { exec } from 'node:child_process';",
    'export function runTool(argument: string) {',
    '  exec(`tool ${argument}`);',
    '}',
  ].join('\n'),
  // Lines 13 and 14 reach the sink through a type assertion, which the binding helpers strip.
  'app.ts': [
    "import express from 'express';",
    "import { exec } from 'node:child_process';",
    "import { runTool } from './helper';",
    '',
    "const API_KEY = 'sk_live_4eC39HqLyjWDarjtT1zdp7dc';",
    'const app = express();',
    '',
    "app.get('/direct', (req, res) => {",
    '  exec(`ls ${req.query.dir}`);',
    "  res.send('ok');",
    '});',
    "app.get('/asserted', (req, res) => {",
    '  exec(`ls ${req.query.dir as string}`);',
    '  exec(`ls ${<any>req.query.other}`);',
    "  res.send('ok');",
    '});',
    "app.get('/helper', (req, res) => {",
    '  runTool(req.query.name as string);',
    '  res.send(API_KEY);',
    '});',
  ].join('\n'),
};

function makeProject(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-sec-native-parity-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents);
  return directory;
}

const keyOf = (finding) => `${finding.ruleId}:${path.basename(finding.file)}:${finding.line}`;
const keysOf = (result) => result.findings.map(keyOf).sort();

function runCli(directory, engine) {
  const run = spawnSync(process.execPath, [bin, 'sec', '-p', 'tsconfig.json', '--engine', engine, '--json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  const { stdout } = run;
  const result = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
  return { result, stderr: run.stderr };
}

test('sec --engine native reports the JS engine findings', { skip: nativeSkip }, (context) => {
  const directory = makeProject(context);
  const js = runCli(directory, 'js');
  const native = runCli(directory, 'native');
  assert.match(native.stderr, /native engine finds less/);
  assert.equal(native.result.skippedFiles, undefined);
  assert.deepEqual(keysOf(native.result), keysOf(js.result));
  const expected = [
    'command-injection:app.ts:9',
    'command-injection:app.ts:13',
    'command-injection:app.ts:14',
    'command-injection:helper.ts:3',
    'hardcoded-secret:app.ts:5',
  ];
  for (const key of expected) assert.ok(keysOf(js.result).includes(key), `JS engine lacks ${key}`);
});

// The rules bind to one compiler per process, so the JS engine runs in a child process of its own.
const jsEngineScript = `
  const { analyzer } = require('./lib/security/cli.cjs');
  const { analyzeSources } = require('./lib/performance/projects.cjs');
  const { findings } = analyzeSources({ files: [process.argv[1]], analyzers: [analyzer] });
  process.stdout.write(JSON.stringify(findings));
`;

test('analyzeNative with the security analyzer matches analyzeSources', { skip: nativeSkip }, (context) => {
  const directory = makeProject(context);
  const file = path.join(directory, 'helper.ts');
  const { analyzer } = require('../../lib/security/cli.cjs');
  const { analyzeNative } = require('../../lib/performance/native.cjs');
  const nativeResult = analyzeNative({ files: [file], fallback: true, analyzers: [analyzer] });
  if (nativeResult.fallback) return context.skip(`native engine fell back: ${nativeResult.reason ?? 'unavailable'}`);
  const jsRun = spawnSync(process.execPath, ['-e', jsEngineScript, file], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  const jsKeys = JSON.parse(jsRun.stdout).map(keyOf).sort();
  assert.deepEqual(nativeResult.skippedFiles ?? [], []);
  assert.deepEqual(keysOf(nativeResult), jsKeys);
  assert.ok(jsKeys.some((key) => key.startsWith('command-injection:')));
});

test(
  'sec with the default engine uses the JS engine and says nothing about native',
  { skip: nativeSkip },
  (context) => {
    const directory = makeProject(context);
    const auto = runCli(directory, 'auto');
    assert.doesNotMatch(auto.stderr, /native engine finds less/);
    assert.deepEqual(keysOf(auto.result), keysOf(runCli(directory, 'js').result));
  },
);

test('native scans a file whose call signature is declared in the same file', { skip: nativeSkip }, (context) => {
  const directory = makeProject(context);
  fs.writeFileSync(
    path.join(directory, 'signature.ts'),
    'export async function load(db: { find(): Promise<string[]> }) { return db.find(); }',
  );
  const run = spawnSync(process.execPath, [bin, 'sec', 'signature.ts', '--engine', 'native', '--json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  const { stdout } = run;
  const result = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
  assert.equal(result.skippedFiles, undefined, run.stderr);
  assert.equal(result.scannedFiles, 1);
});
