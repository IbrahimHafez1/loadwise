// The security checker must report the same findings under the TypeScript 7 native engine and the
// JS engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import type { Finding } from '../../lib/shared/types.cjs';
import { analyzer } from '../../lib/security/cli.cjs';
import type * as PerformanceNative from '../../lib/performance/native.cjs';
import type * as PerformanceNativeRuntime from '../../lib/performance/native-runtime.cjs';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
let nativeSkip = nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!nativeSkip) {
    const performanceNativeRuntimeModule: typeof PerformanceNativeRuntime = require('../../lib/performance/native-runtime.cjs');
    performanceNativeRuntimeModule.executable();
  }
} catch {
  nativeSkip = 'optional native compiler is absent';
}

interface ParityReport {
  findings: Finding[];
  skippedFiles?: unknown;
  scannedFiles?: number;
}

const files: Record<string, string> = {
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

function makeProject(context: TestContext, projectFiles = files) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-sec-native-parity-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(projectFiles)) fs.writeFileSync(path.join(directory, name), contents);
  return directory;
}

const keyOf = (finding: Finding) => `${finding.ruleId}:${path.basename(finding.file ?? '')}:${finding.line}`;
const keysOf = (result: ParityReport) => result.findings.map(keyOf).sort();

function runCli(directory: string, engine: string, extraArgs: string[] = []) {
  const run = spawnSync(
    process.execPath,
    [bin, 'sec', '-p', 'tsconfig.json', '--engine', engine, '--json', ...extraArgs],
    {
      cwd: directory,
      encoding: 'utf8',
    },
  );
  const { stdout } = run;
  const result: ParityReport = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
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
  const { analyzeNative }: typeof PerformanceNative = require('../../lib/performance/native.cjs');
  const nativeResult = analyzeNative({ files: [file], fallback: true, analyzers: [analyzer] });
  if (nativeResult.fallback) return context.skip(`native engine fell back: ${nativeResult.reason ?? 'unavailable'}`);
  const jsRun = spawnSync(process.execPath, ['-e', jsEngineScript, file], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  const jsFindings: Finding[] = JSON.parse(jsRun.stdout);
  const jsKeys = jsFindings.map(keyOf).sort();
  assert.deepEqual(nativeResult.skippedFiles ?? [], []);
  assert.deepEqual(keysOf(nativeResult), jsKeys);
  assert.ok(jsKeys.some((key: string) => key.startsWith('command-injection:')));
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
  const result: ParityReport = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
  assert.equal(result.skippedFiles, undefined, run.stderr);
  assert.equal(result.scannedFiles, 1);
});

// The OWASP NodeGoat shape: a JavaScript constructor function's `this.find = ...` method, called on
// an instance in another file. TypeScript 7 does not type JavaScript constructor functions, so the
// call has no signature there.
const constructorFiles: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'commonjs', allowJs: true, strict: true, esModuleInterop: true },
    files: ['user-dao.js', 'allocations-dao.js', 'routes.js'],
  }),
  'user-dao.js': [
    'function UserDAO(db) {',
    "  const users = db.collection('users');",
    '  this.findByName = function (userName, callback) {',
    '    users.findOne({ userName: userName }, callback);',
    '  };',
    '}',
    'module.exports = { UserDAO };',
  ].join('\n'),
  'allocations-dao.js': [
    'const AllocationsDAO = function (db) {',
    "  const allocations = db.collection('allocations');",
    '  this.above = (threshold, callback) => {',
    '    allocations.find({ $where: `this.stocks > ${threshold}` }, callback);',
    '  };',
    '};',
    'module.exports.AllocationsDAO = AllocationsDAO;',
  ].join('\n'),
  'routes.js': [
    "const { UserDAO } = require('./user-dao');",
    "const AllocationsDAO = require('./allocations-dao').AllocationsDAO;",
    'function Handler(db) {',
    '  const userDAO = new UserDAO(db);',
    '  const allocationsDAO = new AllocationsDAO(db);',
    '  this.login = (req, res) => userDAO.findByName(req.body.userName, () => res.end());',
    '  this.allocations = (req, res) => allocationsDAO.above(req.query.threshold, () => res.end());',
    '}',
    'module.exports = Handler;',
  ].join('\n'),
};

test('native traces request data into JavaScript constructor function methods', { skip: nativeSkip }, (context) => {
  const directory = makeProject(context, constructorFiles);
  const js = runCli(directory, 'js');
  const native = runCli(directory, 'native');
  assert.deepEqual(keysOf(native.result), keysOf(js.result));
  for (const key of ['nosql-operator-injection:user-dao.js:4', 'nosql-operator-injection:allocations-dao.js:4'])
    assert.ok(keysOf(native.result).includes(key), `native engine lacks ${key}`);
});

const express = "import express from 'express';\nconst app = express();\ndeclare const handler: any;\n";
const rateLimitFiles: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, esModuleInterop: true },
    files: ['limits.ts', 'applied.ts', 'other-router.ts', 'connected.ts', 'bare.ts'],
  }),
  'limits.ts': "import rateLimit from 'express-rate-limit';\nexport const loginLimiter = rateLimit({ max: 5 });",
  // Accepted: the route's own app applies the limiter.
  'applied.ts': `${express}import { loginLimiter } from './limits';
app.use(loginLimiter);
app.post('/login', handler);`,
  // Contextual: the limiter is applied to a different router in the same file.
  'other-router.ts': `${express}import { loginLimiter } from './limits';
const admin = express.Router();
admin.use(loginLimiter);
app.use('/admin', admin);
app.post('/login', handler);`,
  // Contextual: a limiter module is imported but not shown applied.
  'connected.ts': `${express}import { loginLimiter } from './limits';
void loginLimiter;
app.post('/login', handler);`,
  'bare.ts': `${express}app.post('/signup', handler);`,
};

const reasonKeysOf = (result: ParityReport) =>
  result.findings
    .map((finding: Finding) => `${keyOf(finding)}:${finding.contextualReason ? 'contextual' : 'default'}`)
    .sort();

test('native decides rate limits on auth routes as the JS engine does', { skip: nativeSkip }, (context) => {
  const directory = makeProject(context, rateLimitFiles);
  const js = runCli(directory, 'js', ['--include-contextual']);
  const native = runCli(directory, 'native', ['--include-contextual']);
  const nativeKeys = reasonKeysOf(native.result).filter((key) => key.startsWith('auth-route-without-rate-limit:'));
  assert.deepEqual(
    nativeKeys,
    reasonKeysOf(js.result).filter((key) => key.startsWith('auth-route-without-rate-limit:')),
  );
  assert.deepEqual(nativeKeys, [
    'auth-route-without-rate-limit:bare.ts:4:default',
    'auth-route-without-rate-limit:connected.ts:6:contextual',
    'auth-route-without-rate-limit:other-router.ts:8:contextual',
  ]);
});
