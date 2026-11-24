import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import type * as NativeRuntime from '../../lib/performance/native-runtime.cjs';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) {
    const nativeRuntime: typeof NativeRuntime = require('../../lib/performance/native-runtime.cjs');
    nativeRuntime.executable();
  }
} catch {
  skip = 'optional native compiler is absent';
}

test('a missing package base is dropped by the native engine instead of falling back', { skip }, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-native-missing-base-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = {
    extends: '@internal/missing-cfg/esm.json',
    compilerOptions: { module: 'commonjs', target: 'es2022', strict: true },
    include: ['index.ts'],
  };
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify(config));
  fs.writeFileSync(
    path.join(directory, 'index.ts'),
    'export async function load(ids: string[]) { for (const id of ids) { await fetch("https://x/" + id); } }\n',
  );
  const run = (engine: string) =>
    spawnSync(process.execPath, [bin, 'perf', '--engine', engine, '-p', 'tsconfig.json', '--json'], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, LOADWISE_AGENT: '0' },
    });
  const baseNote = /Note: .*tsconfig\.json\(1,12\) File '@internal\/missing-cfg\/esm\.json' not found\. Checked with/;
  const native = run('native');
  assert.match(native.stderr, baseNote);
  const auto = run('auto');
  assert.doesNotMatch(auto.stderr, /TypeScript 7 cannot load this project/);
  const javascript = run('js');
  // The report names its engine, so the engines are compared on everything else.
  const withoutEngine = (engineRun: SpawnSyncReturns<string>) => ({
    ...JSON.parse(engineRun.stdout),
    engine: undefined,
  });
  assert.deepEqual(withoutEngine(native), withoutEngine(javascript));
  assert.deepEqual(withoutEngine(auto), withoutEngine(javascript));
  assert.equal(JSON.parse(auto.stdout).engine, 'native');
  assert.equal(JSON.parse(native.stdout).scannedFiles, 1);
});
