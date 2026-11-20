'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');

// A project as cloned: sources and config only, no node_modules.
function uninstalledProject(context, tsconfig) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-uninstalled-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify(tsconfig));
  fs.writeFileSync(
    path.join(directory, 'index.ts'),
    "import { PrismaClient } from '@prisma/client';\nexport const client = new PrismaClient();\n",
  );
  return directory;
}

function runIn(directory, args) {
  return spawnSync(process.execPath, [bin, 'perf', '--engine', 'js', ...args], { cwd: directory, encoding: 'utf8' });
}

test('a missing `types` entry is noted on stderr instead of aborting the scan', (context) => {
  const directory = uninstalledProject(context, {
    compilerOptions: { types: ['jest'], module: 'commonjs', target: 'es2022' },
    include: ['index.ts'],
  });
  const result = runIn(directory, ['-p', 'tsconfig.json', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Note: type libraries not installed \(jest\)/);
  assert.equal(JSON.parse(result.stdout).scannedFiles, 1);
});

test('other compiler option errors stay fatal', (context) => {
  const directory = uninstalledProject(context, {
    compilerOptions: { module: 'commonjs', target: 'es2022', outFile: 'out.js', composite: true },
    include: ['index.ts'],
  });
  const result = runIn(directory, ['-p', 'tsconfig.json']);
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stderr, /type libraries not installed/);
});

test('an imported ORM package that cannot be resolved is noted on stderr only', (context) => {
  const directory = uninstalledProject(context, { compilerOptions: { module: 'commonjs' }, include: ['index.ts'] });
  const result = runIn(directory, ['-p', 'tsconfig.json', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Note: @prisma\/client is imported but not installed .*prisma generate/);
  assert.doesNotMatch(result.stdout, /not installed/);
  assert.equal(JSON.parse(result.stdout).scannedFiles, 1);
});

test('a tsconfig base from an uninstalled package is noted while a missing relative base still fails', (context) => {
  const packageBase = uninstalledProject(context, {
    extends: '@workspace/tsconfig/library.json',
    compilerOptions: { module: 'commonjs' },
    include: ['index.ts'],
  });
  const noted = runIn(packageBase, ['-p', 'tsconfig.json', '--json']);
  assert.equal(noted.status, 0, noted.stderr);
  assert.match(noted.stderr, /Note: .*@workspace\/tsconfig\/library\.json.*own settings/);
  assert.equal(JSON.parse(noted.stdout).scannedFiles, 1);

  const relativeBase = uninstalledProject(context, { extends: './missing.json', include: ['index.ts'] });
  assert.equal(runIn(relativeBase, ['-p', 'tsconfig.json']).status, 2);
});
