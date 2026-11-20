'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

function fsLines(source) {
  return lint(source).filter(diagnostic => diagnostic.ruleId === 'node-sync-fs-in-async')
    .map(diagnostic => diagnostic.line);
}

test('native symbol batches preserve unresolved identifiers and aliases across chunk boundaries', () => {
  const calls = Array.from({ length: 520 }, (_, index) =>
    [0, 255, 256, 511, 519].includes(index) ? 'read("fixture");' : 'unresolved();');
  const source = ['import { readFileSync as read } from "node:fs";', 'async function load() {', ...calls, '}'].join('\n');
  assert.deepEqual(fsLines(source), [3, 258, 259, 514, 522]);
});

test('identifies genuine filesystem imports and reports each blocking call once', () => {
  const source = [
    "import * as disk from 'node:fs';",
    "import fileSystem from 'fs';",
    "import { readFileSync as load } from 'fs';",
    "import nodeFs = require('node:fs');",
    "import { default as system } from 'node:fs';",
    'async function processFile(path: string) {',
    '  load(path);',
    '  disk.statSync(path);',
    "  fileSystem['writeFileSync'](path, 'content');",
    '  nodeFs.readFileSync(path);',
    '  system.statSync(path);',
    '}',
  ].join('\n');
  assert.deepEqual(fsLines(source), [7, 8, 9, 10, 11]);
});

test('limits diagnostics to async execution and ignores same-named user code', () => {
  const source = [
    "import * as disk from 'fs';",
    "import { readFileSync as load } from 'node:fs';",
    "import { readFileSync as elsewhere } from './virtual';",
    'disk.readFileSync("startup");',
    'async function processFile() {',
    '  const other = { readFileSync() {} };',
    '  other.readFileSync(); elsewhere("memory");',
    '  async function shadow(load: Function) { load("memory"); }',
    '  function deferred() { disk.readFileSync("later"); }',
    '  const deferredArrow = () => load("later");',
    '  class Later { field = disk.readFileSync("later"); }',
    '  await disk.promises.readFile("async");',
    '  (() => disk.readFileSync("now"))();',
    '  (function* () { disk.readFileSync("later"); })();',
    '}',
    'class Worker { async run() { load("now"); } }',
  ].join('\n');
  assert.deepEqual(fsLines(source), [13, 16]);
});

test('resolves CommonJS constants and rejects shadowed require or mutable bindings', () => {
  const source = [
    "const disk = require('fs');",
    "const { readFileSync: load } = require('node:fs');",
    "let changeable = require('fs');",
    'async function run() {',
    "  require('node:fs').statSync('now');",
    "  disk.readFileSync('now');",
    "  load('now');",
    "  changeable.statSync('unverified');",
    '}',
    'async function local(require: (name: string) => any) {',
    "  const disk = require('fs');",
    "  const { readFileSync: load } = require('fs');",
    "  disk.statSync('memory'); load('memory');",
    '}',
  ].join('\n');
  assert.deepEqual(fsLines(source), [5, 6, 7]);
});

test('identifies blocking compression, password derivation, key generation and child processes on async paths', () => {
  const findings = lint([
    "import { gzipSync as compress } from 'node:zlib';",
    "import * as crypto from 'crypto';",
    "const { spawnSync: runChild } = require('child_process');",
    "async function serve(input: string) {",
    "  compress(input);",
    "  crypto.scryptSync(input, 'salt', 32);",
    "  crypto.generateKeyPairSync('ed25519');",
    "  runChild('worker');",
    "  (() => require('node:zlib').brotliDecompressSync(input))();",
    "}",
  ].join('\n'));
  assert.deepEqual(findings.map(({ ruleId, line }) => [ruleId, line]), [
    ['node-sync-compression-in-async', 5], ['node-sync-crypto-in-async', 6], ['node-sync-crypto-in-async', 7],
    ['node-sync-process-in-async', 8], ['node-sync-compression-in-async', 9],
  ]);
});

test('skips startup, asynchronous equivalents, deferred calls and lookalikes across built-ins', () => {
  assert.deepEqual(lint(`
    import compression from 'node:zlib';
    import crypto from 'node:crypto';
    import processes from 'node:child_process';
    compression.gzipSync('startup');
    async function run() {
      compression.gzip('value', () => {});
      crypto.scrypt('input', 'salt', 32, () => {});
      processes.spawn('worker');
      const later = () => processes.execSync('later');
      const local = { gzipSync() {} };
      local.gzipSync();
      crypto.gzipSync();
      compression.pbkdf2Sync();
    }
  `), []);
});

function classifiedCalls(source) {
  return lint(source).filter(finding => finding.ruleId.startsWith('node-sync-'))
    .map(({ line, contextualReason }) => [line, Boolean(contextualReason)]);
}

test('only one-off work in a private process entry point gets startup context', () => {
  const source = [
    "import { readFileSync as read } from 'node:fs';",
    "async function bootstrap() {",
    "  read('config');",
    "  for (const file of paths) read(file);",
    "  server.on('request', async () => read('per-request'));",
    "}",
    "void bootstrap().catch(() => { process.exitCode = 1; });",
    "async function shared() { read('runtime'); }",
    "if (require.main === module) shared();",
    "server.on('request', shared);",
    "async function main() { read('options'); }",
    "if (module === require.main) { main(); }",
    "export async function exported() { read('runtime'); }",
    "exported().catch(() => process.exit(1));",
    "async function ordinary() { read('work'); }",
    "ordinary().catch(reportError);",
    "async function launch() { void startOtherWork(); read('while-running'); }",
    "if (require.main === module) launch();",
    "async function handoff() { void (async () => read('callback'))(); }",
    "if (require.main === module) handoff();",
  ].join('\n');
  assert.deepEqual(classifiedCalls(source), [
    [3, true], [4, false], [5, false], [8, false], [11, true], [13, false], [15, false],
    [17, false], [19, false],
  ]);
});

test('one-off fixture work gets context only in direct nonconcurrent unit-test registrations', () => {
  const source = [
    "import { readFileSync as read } from 'node:fs';",
    "import { it as check, beforeAll, describe } from 'vitest';",
    "import nodeTest from 'node:test';",
    "const { test: unit } = require('node:test');",
    "import { test as browserTest } from '@playwright/test';",
    "check('fixture', async () => { read('fixture'); });",
    "beforeAll(async () => { read('suite config'); });",
    "nodeTest('fixture', async () => read('fixture'));",
    "unit('fixtures', async () => { for (const file of paths) read(file); });",
    "unit('concurrent', { concurrency: true }, async () => read('shared'));",
    "browserTest('browser', async () => read('download'));",
    "check('handler', async () => { server.on('request', async () => read('request')); });",
    "describe.concurrent('group', () => { check('case', async () => read('shared')); });",
    "function local(check: Function) { check('name', async () => read('custom')); }",
    "const defaultTest = require('node:test');",
    "defaultTest('fixture', async () => read('setup'));",
    "check('parallel work', async () => { await Promise.all([startWorker(), read('input')]); });",
    "nodeTest({ concurrency: true }, async () => read('shared'));",
    "nodeTest(options, async () => read('unknown'));",
    "describe({ concurrency: true }, () => { nodeTest('nested', async () => read('shared')); });",
    "describe.concurrent.each(cases)('group', () => { check('case', async () => read('shared')); });",
  ].join('\n');
  assert.deepEqual(classifiedCalls(source), [
    [6, true], [7, true], [8, true], [9, false], [10, false], [11, false],
    [12, false], [13, false], [14, false], [16, true], [17, false], [18, false],
    [19, false], [20, false], [21, false],
  ]);
});
