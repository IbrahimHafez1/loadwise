'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'bin/loadwise.cjs');
const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) require('../../lib/performance/native-runtime.cjs').executable();
} catch {
  skip = 'optional native compiler is absent';
}

// The membership rule needs the array type, so each finding proves its type import resolved.
const sources = {
  'src/lib/types.ts': 'export type Ids = string[];',
  'src/app/types.ts': 'export type AppIds = string[];',
  'src/index.ts': [
    "import type { Ids } from 'lib/types';",
    "import type { AppIds } from '@app/types';",
    'export function check(keys: string[], payload: string) {',
    '  const ids: Ids = JSON.parse(payload);',
    '  return keys.map((key) => ids.includes(key));',
    '}',
    'export function checkApp(keys: string[], payload: string) {',
    '  const ids: AppIds = JSON.parse(payload);',
    '  return keys.map((key) => ids.includes(key));',
    '}',
  ].join('\n'),
};

function scanBothEngines(context, configs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-native-base-url-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries({ ...sources, ...configs })) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), contents);
  }
  const run = (engine) =>
    spawnSync(process.execPath, [bin, 'perf', '--engine', engine, '-p', 'tsconfig.json', '--json'], {
      cwd: directory,
      encoding: 'utf8',
    });
  const native = run('native');
  assert.doesNotMatch(native.stderr, /Note:/);
  const findings = JSON.parse(native.stdout).findings;
  assert.deepEqual(
    findings.map((finding) => [finding.ruleId, finding.line]),
    [
      ['array-repeated-membership', 5],
      ['array-repeated-membership', 9],
    ],
  );
  assert.deepEqual(findings, JSON.parse(run('js').stdout).findings);
}

test('native scan resolves baseUrl imports and paths without falling back', { skip }, (context) => {
  const compilerOptions = { baseUrl: './src', paths: { '@app/*': ['app/*'] }, target: 'es2022', module: 'commonjs' };
  scanBothEngines(context, { 'tsconfig.json': JSON.stringify({ compilerOptions, include: ['src'] }) });
});

test('native scan resolves a baseUrl inherited from an extended config', { skip }, (context) => {
  const baseOptions = { baseUrl: '../src', target: 'es2022', module: 'commonjs' };
  const tsconfig = {
    extends: './config/base.json',
    compilerOptions: { paths: { '@app/*': ['app/*'] } },
    include: ['src'],
  };
  scanBothEngines(context, {
    'config/base.json': JSON.stringify({ compilerOptions: baseOptions }),
    'tsconfig.json': JSON.stringify(tsconfig),
  });
});
