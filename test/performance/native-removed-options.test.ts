import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Finding } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';
import type { FixtureTsconfig } from '../types/site-fixes.js';
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

const source = [
  'export function check(keys: string[], payload: string) {',
  '  const ids: string[] = JSON.parse(payload);',
  '  return keys.map((key) => ids.includes(key));',
  '}',
].join('\n');

function run(directory: string, engine: string) {
  return spawnSync(process.execPath, [bin, 'perf', '--engine', engine, '-p', 'tsconfig.json', '--json'], {
    cwd: directory,
    encoding: 'utf8',
  });
}

type CompilerOptionsJson = NonNullable<FixtureTsconfig['compilerOptions']>;

// `--engine native` reports a rejected option instead of falling back, so a clean native run proves
// the options were translated.
function scanNative(context: TestContext, compilerOptions: CompilerOptionsJson, extraFiles: FileMap = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-native-options-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {
    'src/index.ts': source,
    'tsconfig.json': JSON.stringify({ compilerOptions, include: ['src'] }),
    ...extraFiles,
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), contents);
  }
  const native = run(directory, 'native');
  assert.doesNotMatch(native.stderr, /Note:|has been removed|Unknown compiler option/);
  const findings = JSON.parse(native.stdout).findings;
  assert.deepEqual(
    findings.map((finding: Finding) => finding.ruleId),
    ['array-repeated-membership'],
  );
  assert.deepEqual(findings, JSON.parse(run(directory, 'js').stdout).findings);
  return directory;
}

const translated = {
  'esModuleInterop false': { esModuleInterop: false, target: 'es2022', module: 'commonjs' },
  'allowSyntheticDefaultImports false': { allowSyntheticDefaultImports: false, target: 'es2022', module: 'commonjs' },
  'alwaysStrict false': { alwaysStrict: false, target: 'es2022', module: 'commonjs' },
  downlevelIteration: { downlevelIteration: true, target: 'es2022', module: 'commonjs' },
  outFile: { outFile: 'out.js', target: 'es2022', module: 'amd', moduleResolution: 'node10' },
  'moduleResolution node10 with commonjs': { moduleResolution: 'node10', target: 'es2022', module: 'commonjs' },
  'moduleResolution node alias': { moduleResolution: 'node', target: 'es2022', module: 'esnext' },
  'node10 with module umd': { moduleResolution: 'node10', target: 'es2022', module: 'umd' },
  'node10 with module system': { moduleResolution: 'node10', target: 'es2022', module: 'system' },
  'target es5 with explicit lib': { target: 'es5', lib: ['es2022'], module: 'commonjs' },
};

for (const [name, compilerOptions] of Object.entries(translated)) {
  test(`native scan translates ${name} without falling back`, { skip }, (context) => {
    scanNative(context, compilerOptions);
  });
}

// The JS engine's TypeScript 6 rejects these itself, so only the native engine can scan them.
for (const compilerOptions of [
  { importsNotUsedAsValues: 'error' },
  { preserveValueImports: true },
  { suppressExcessPropertyErrors: true },
]) {
  test(`native scan ignores ${Object.keys(compilerOptions)[0]}`, { skip }, (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-native-options-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(path.join(directory, 'src/index.ts'), source);
    const tsconfig = { compilerOptions: { ...compilerOptions, module: 'commonjs' }, include: ['src'] };
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify(tsconfig));
    const native = run(directory, 'native');
    assert.doesNotMatch(native.stderr, /removed|Unknown compiler option/);
    assert.equal(JSON.parse(native.stdout).findings.length, 1);
  });
}

test('native scan keeps resolving through node10 after the move to bundler', { skip }, (context) => {
  const scanned = {
    'src/index.ts': [
      "import type { Ids } from './lib';",
      'export function check(keys: string[], payload: string) {',
      '  const ids: Ids = JSON.parse(payload);',
      '  return keys.map((key) => ids.includes(key));',
      '}',
    ].join('\n'),
    'src/lib/index.ts': 'export type Ids = string[];',
  };
  scanNative(context, { moduleResolution: 'node10', target: 'es2022', module: 'commonjs' }, scanned);
});

for (const [name, compilerOptions] of Object.entries({
  'moduleResolution classic': { moduleResolution: 'classic', module: 'commonjs' },
  'target es5 without lib': { target: 'es5', module: 'commonjs' },
  keyofStringsOnly: { keyofStringsOnly: true, target: 'es2022', module: 'commonjs' },
})) {
  test(`${name} is still rejected by the native engine, leaving the JS fallback`, { skip }, (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-native-options-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(path.join(directory, 'src/index.ts'), source);
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src'] }));
    assert.match(run(directory, 'native').stderr, /has been removed|Unknown compiler option/);
  });
}
