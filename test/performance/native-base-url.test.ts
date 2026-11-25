import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Finding } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';
import * as nativeRuntime from '../../lib/performance/native-runtime.js';

const root = path.resolve(import.meta.dirname, '../..');
const bin = path.join(root, 'bin/loadwise.js');
const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) nativeRuntime.executable();
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

function scanBothEngines(context: TestContext, configs: FileMap) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-native-base-url-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries({ ...sources, ...configs })) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), contents);
  }
  const run = (engine: string) =>
    spawnSync(process.execPath, [bin, 'perf', '--engine', engine, '-p', 'tsconfig.json', '--json'], {
      cwd: directory,
      encoding: 'utf8',
    });
  const native = run('native');
  assert.doesNotMatch(native.stderr, /Note:/);
  const findings = JSON.parse(native.stdout).findings;
  assert.deepEqual(
    findings.map((finding: Finding) => [finding.ruleId, finding.line]),
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
