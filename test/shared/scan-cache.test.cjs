'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runChecker } = require('../../lib/shared/pillars.cjs');
const { stats } = require('../../lib/shared/scan-cache.cjs');

// manual-session.cjs turns the cache off for every other test.
delete process.env.LOADWISE_NO_CACHE;

const duplicatedSource = Array.from({ length: 3 }, (_unused, index) =>
  [
    `export function compute${index}(values: number[]) {`,
    '  let total = 0;',
    '  for (const value of values) {',
    '    if (value > 10) total += value * 2;',
    '    else if (value > 5) total += value;',
    '    else total -= value;',
    '  }',
    '  return total;',
    '}',
  ].join('\n'),
).join('\n');

// Each test gets its own cache folder, so it never reads or fills the user's cache.
function isolateCache(context) {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-scan-cache-'));
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.LOCALAPPDATA = cacheRoot;
  process.env.XDG_CACHE_HOME = cacheRoot;
  context.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });
}

function project(context, { git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-scan-cache-project-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'math.ts'), duplicatedSource);
  if (git) spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  return root;
}

function counts() {
  return { ...stats };
}

function delta(before) {
  return Object.fromEntries(Object.keys(stats).map((name) => [name, stats[name] - before[name]]));
}

test('an identical rerun replays the stored report byte for byte', async (context) => {
  isolateCache(context);
  const root = project(context);
  const before = counts();
  const first = await runChecker(['maint', '.', '--json'], root);
  const second = await runChecker(['maint', '.', '--json'], root);
  assert.deepEqual(delta(before), { hits: 1, misses: 1, bypasses: 0 });
  assert.ok([0, 1].includes(first.code), first.stderr);
  assert.deepEqual(second, first);
});

test('an install that rewrites node_modules misses even though git ignores it', async (context) => {
  isolateCache(context);
  const root = project(context);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), '{}');
  await runChecker(['maint', '.', '--json'], root);
  const before = counts();
  fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), '{"packages":{}}');
  await runChecker(['maint', '.', '--json'], root);
  await runChecker(['maint', '.', '--json'], root);
  assert.deepEqual(delta(before), { hits: 1, misses: 1, bypasses: 0 });
});

test('editing a source file or changing the args misses', async (context) => {
  isolateCache(context);
  const root = project(context);
  await runChecker(['maint', '.', '--json'], root);
  const before = counts();
  fs.appendFileSync(path.join(root, 'math.ts'), '\nexport const extra = 1;\n');
  await runChecker(['maint', '.', '--json'], root);
  await runChecker(['maint', '.'], root);
  assert.deepEqual(delta(before), { hits: 0, misses: 2, bypasses: 0 });
});

test('LOADWISE_NO_CACHE and fix-style flags bypass the cache', async (context) => {
  isolateCache(context);
  const root = project(context);
  context.after(() => delete process.env.LOADWISE_NO_CACHE);
  process.env.LOADWISE_NO_CACHE = '1';
  const before = counts();
  await runChecker(['maint', '.', '--json'], root);
  await runChecker(['maint', '.', '--json'], root);
  delete process.env.LOADWISE_NO_CACHE;
  await runChecker(['maint', '.', '--json', '--staged'], root);
  assert.deepEqual(delta(before), { hits: 0, misses: 0, bypasses: 3 });
});

test('a folder outside git runs uncached', async (context) => {
  isolateCache(context);
  const root = project(context, { git: false });
  // A temp folder nested in a repository would still be cached; this test needs one that is not.
  const inside = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { windowsHide: true });
  if (inside.status === 0) return context.skip('the temp folder is inside a git repository');
  const before = counts();
  const first = await runChecker(['maint', '.', '--json'], root);
  const second = await runChecker(['maint', '.', '--json'], root);
  assert.deepEqual(delta(before), { hits: 0, misses: 0, bypasses: 2 });
  assert.equal(second.stdout, first.stdout);
});

test('a run that exits 2 for skipped files is not stored', async (context) => {
  isolateCache(context);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-scan-cache-skipped-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'broken.ts'), 'export const broken = ;');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"files":["broken.ts"]}');
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  const args = ['perf', '-p', 'tsconfig.json', '--json', '--engine', 'js'];
  const first = await runChecker(args, root);
  assert.equal(first.code, 2);
  const before = { ...stats };
  await runChecker(args, root);
  assert.equal(stats.hits, before.hits);
  assert.equal(stats.misses, before.misses + 1);
});
