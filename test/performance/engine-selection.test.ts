import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as nativeRuntime from '../../lib/performance/native-runtime.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const [major, minor] = process.versions.node.split('.').map(Number);
let nativeSkip: string | false = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!nativeSkip) nativeRuntime.executable();
} catch {
  nativeSkip = 'optional native compiler is absent';
}
const fallbackNote =
  /^Note: TypeScript 7 cannot load this project \(.*[Cc]lassic.*\); used TypeScript 6\.\d+\.\d+\.\n$/;

function fixture(context: TestContext) {
  const files = {
    // A parsed array has an unknown, possibly large size, so the includes() finding is enforced,
    // not contextual.
    'flag.ts':
      'export function check(keys: string[], raw: string) { const ids: string[] = JSON.parse(raw); return keys.map(key => ids.includes(key)); }',
    'clean.ts': 'export const message = "ok";',
    'tsconfig.json': '{"compilerOptions":{"target":"ES2022","strict":true},"files":["flag.ts","clean.ts"]}',
    'base.json': '{"compilerOptions":{"target":"ES2022","moduleResolution":"classic"},"files":["flag.ts","clean.ts"]}',
    'bad.ts': 'export const broken = ;',
    // Reports at exit whether any native engine module was loaded into the CLI process.
    // Named like a tool config, which the note on JavaScript a tsconfig leaves out does not list.
    'probe.config.mjs': [
      "import { registerHooks } from 'node:module';",
      'let nativeLoaded = false;',
      'registerHooks({',
      '  load(url, context, nextLoad) {',
      '    if (/[\\\\/]lib[\\\\/]performance[\\\\/]native/.test(url)) nativeLoaded = true;',
      '    return nextLoad(url, context);',
      '  },',
      '});',
      "process.on('exit', () => { if (nativeLoaded) process.stderr.write('native loaded'); });",
    ].join('\n'),
  };
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'backend-perf-engine-'));
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents);
  context.after(() => {
    for (const name of Object.keys(files)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return (args: string[], nodeOptions: string[] = []) =>
    spawnSync(process.execPath, [...nodeOptions, bin, 'perf', ...args], { cwd: directory, encoding: 'utf8' });
}

test('auto falls back to TypeScript 6 for a config TypeScript 7 rejects', { skip: nativeSkip }, (context) => {
  const run = fixture(context);
  const auto = run(['-p', 'base.json', '--json']);
  const js = run(['-p', 'base.json', '--json', '--engine', 'js']);
  assert.equal(auto.status, 1, auto.stderr);
  assert.equal(js.status, 1, js.stderr);
  assert.deepEqual(JSON.parse(auto.stdout), JSON.parse(js.stdout));
  assert.equal(JSON.parse(auto.stdout).findings.length, 1);
  assert.match(auto.stderr, fallbackNote);
  assert.equal(js.stderr, '');
  const text = run(['-p', 'base.json']);
  assert.equal(text.status, 1);
  assert.doesNotMatch(text.stdout, /TypeScript 7/);
  assert.match(text.stderr, fallbackNote);
});

test('auto matches the JS engine on a compatible project and uses native', { skip: nativeSkip }, (context) => {
  const run = fixture(context);
  const auto = run(['-p', 'tsconfig.json', '--json'], ['--import', './probe.config.mjs']);
  const js = run(['-p', 'tsconfig.json', '--json', '--engine', 'js']);
  assert.equal(auto.status, 1, auto.stderr);
  assert.deepEqual({ ...JSON.parse(auto.stdout), engine: undefined }, { ...JSON.parse(js.stdout), engine: undefined });
  assert.equal(JSON.parse(auto.stdout).engine, 'native');
  assert.equal(auto.stderr, 'native loaded');
  assert.deepEqual(
    { ...JSON.parse(run(['flag.ts', '--json']).stdout), engine: undefined },
    { ...JSON.parse(run(['flag.ts', '--json', '--engine', 'js']).stdout), engine: undefined },
  );
});

test('forced native still rejects an incompatible config with exit 2', { skip: nativeSkip }, (context) => {
  const run = fixture(context);
  for (const args of [['--native'], ['--engine', 'native']]) {
    const result = run([...args, '-p', 'base.json', '--json']);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /classic/i);
    assert.equal(result.stdout, '');
  }
});

test('auto keeps exit 2 for source errors', (context) => {
  const run = fixture(context);
  const result = run(['bad.ts', '--json']);
  assert.equal(result.status, 2, result.stdout);
  assert.ok(result.stderr.trim());
  assert.doesNotMatch(result.stderr, /TypeScript 7 cannot load/);
});

test('--engine js never loads the native engine', (context) => {
  const run = fixture(context);
  for (const project of ['tsconfig.json', 'base.json']) {
    const result = run(['-p', project, '--json', '--engine', 'js'], ['--import', './probe.config.mjs']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).findings.length, 1);
  }
});

test('engine options are validated', (context) => {
  const run = fixture(context);
  for (const args of [
    ['--engine', 'go'],
    ['--native', '--engine', 'js'],
    ['--watch', '--engine', 'native'],
  ]) {
    const result = run([...args, '-p', 'tsconfig.json']);
    assert.equal(result.status, 2, result.stdout);
    assert.ok(result.stderr.trim());
  }
});
