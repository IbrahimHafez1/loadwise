'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) require('../../lib/performance/native-runtime.cjs').executable();
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
  const run = (engine) =>
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
  assert.equal(native.stdout, javascript.stdout);
  assert.equal(auto.stdout, javascript.stdout);
  assert.equal(JSON.parse(native.stdout).scannedFiles, 1);
});
