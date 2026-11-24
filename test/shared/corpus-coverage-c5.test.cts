// Scan coverage and scope found on public monorepos: folders without their own config, configs that
// pull in files from outside the scanned folder, a jsconfig beside a tsconfig, unbuilt workspace
// packages and uninstalled clients.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Finding } from '../../lib/shared/types.cjs';
import type { TestContext } from 'node:test';
import type { FileMap } from '../types/project-files.cjs';
import type * as ReviewContext from '../../lib/performance/review-context.cjs';

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const slowSource = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
const slowJavaScript = [
  "const { readFileSync } = require('node:fs');",
  'exports.handle = async function (request, response) {',
  "  response.send(readFileSync('template.html', 'utf8'));",
  '};',
  '',
].join('\n');
const pgTypes = 'export declare class Pool { query(text: string, values?: unknown[]): Promise<unknown>; }';
const lowerEmailQuery = "  await pool.query('SELECT * FROM customers WHERE lower(email) = $1', [email]);\n";

function project(context: TestContext, files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-c5-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

function loadwise(cwd: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOADWISE_AGENT: '0' },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

const files = (report: { findings: Finding[] }) =>
  [...new Set(report.findings.map(({ file }: Finding) => file))].sort();

test('check on a folder without its own config uses the ancestor config and reports only that folder', (context) => {
  const root = project(context, {
    'package.json': '{"name":"server"}',
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }),
    'src/api/slow.ts': slowSource,
    'src/other/slow.ts': slowSource,
  });
  const run = loadwise(path.join(root, 'src/api'), 'check', '--json', '--only', 'perf,sec');
  assert.equal(run.code, 1, run.stderr);
  assert.doesNotMatch(run.stderr, /no tsconfig\.json or jsconfig\.json/);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(files(report.performance), ['slow.ts']);
  assert.equal(report.security.scannedFiles, 1);
});

test('a folder that no ancestor config includes keeps the skipped-checker note', (context) => {
  const root = project(context, {
    'package.json': '{"name":"server"}',
    'tsconfig.json': JSON.stringify({ include: ['src/**/*.ts'] }),
    'scripts/slow.ts': slowSource,
  });
  const run = loadwise(path.join(root, 'scripts'), 'check', '--json', '--only', 'perf,sec');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /no tsconfig\.json or jsconfig\.json in .*scripts; skipped/);
  assert.equal(JSON.parse(run.stdout).performance, null);
});

test('the ancestor search stops at the package root', (context) => {
  const root = project(context, {
    'tsconfig.json': JSON.stringify({ include: ['**/*.ts'] }),
    'packages/api/package.json': '{"name":"api"}',
    'packages/api/slow.ts': slowSource,
  });
  const run = loadwise(path.join(root, 'packages/api'), 'check', '--json', '--only', 'perf');
  assert.match(run.stderr, /no tsconfig\.json or jsconfig\.json in .*api\b.*skipped the performance checker/);
});

test('perf reports only files under the config folder, not files its include pulls in from outside', (context) => {
  const root = project(context, {
    'core/slow.ts': slowSource,
    'app/tsconfig.json': JSON.stringify({ include: ['*.ts', '../core/*.ts'] }),
    'app/slow.ts': slowSource,
  });
  for (const engine of ['js', 'auto']) {
    const run = loadwise(path.join(root, 'app'), 'perf', '--json', '--engine', engine);
    assert.equal(run.code, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(files(report), ['slow.ts'], engine);
    assert.equal(report.scannedFiles, 1, engine);
  }
});

test('a referenced config that inherits an uninstalled package base through a relative base is checked', (context) => {
  const base = JSON.stringify({ extends: '@org/tsconfig/base.json', compilerOptions: { strict: true } });
  const root = project(context, {
    'app/tsconfig.json': JSON.stringify({
      extends: '@org/tsconfig/base.json',
      include: ['*.ts'],
      references: [{ path: '../lib/tsconfig.build.json' }, { path: '../other/tsconfig.json' }],
    }),
    'app/slow.ts': slowSource,
    'lib/tsconfig.json': base,
    'lib/tsconfig.build.json': JSON.stringify({ extends: './tsconfig.json', compilerOptions: { composite: true } }),
    'lib/index.ts': 'export const one = 1;\n',
    'other/tsconfig.json': base,
    'other/index.ts': 'export const two = 2;\n',
  });
  const run = loadwise(path.join(root, 'app'), 'perf', '--json', '--engine', 'js');
  assert.equal(run.code, 1, run.stderr);
  // Each missing base is noted once, however many referenced projects inherit it.
  assert.equal(run.stderr.match(/'@org\/tsconfig\/base\.json' not found\. Checked with/g)?.length, 1, run.stderr);
  assert.deepEqual(files(JSON.parse(run.stdout)), ['slow.ts']);
});

test('a missing relative base config stays fatal', (context) => {
  const root = project(context, {
    'tsconfig.json': JSON.stringify({ extends: './missing.json', include: ['*.ts'] }),
    'slow.ts': slowSource,
  });
  const run = loadwise(root, 'perf', '--json', '--engine', 'js');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /missing\.json/);
});

test('check scans the JavaScript a jsconfig covers beside a TypeScript-only tsconfig, once per file', (context) => {
  const root = project(context, {
    'package.json': '{"name":"ghost-like"}',
    'tsconfig.json': JSON.stringify({ include: ['core/**/*.ts'] }),
    'jsconfig.json': JSON.stringify({ compilerOptions: { checkJs: true }, include: ['core/**/*.js', 'core/**/*.ts'] }),
    'core/slow.ts': slowSource,
    'core/model.js': slowJavaScript,
  });
  const run = loadwise(root, 'check', '--json', '--only', 'perf', '--include-contextual');
  assert.equal(run.code, 1, run.stderr);
  const report = JSON.parse(run.stdout).performance;
  assert.deepEqual(files(report), ['core/model.js', 'core/slow.ts']);
  assert.equal(report.scannedFiles, 2);
  const keys = report.findings.map(({ file, line, column, ruleId }: Finding) => [file, line, column, ruleId].join(':'));
  assert.equal(new Set(keys).size, keys.length);
  const explicit = JSON.parse(loadwise(root, 'perf', '-p', 'tsconfig.json', '--json').stdout);
  assert.deepEqual(files(explicit), ['core/slow.ts']);
});

function workspaceWithUnbuiltDatabasePackage(extra = {}) {
  return {
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'node_modules/pg/package.json': '{ "name": "pg", "types": "index.d.ts" }',
    'node_modules/pg/index.d.ts': pgTypes,
    'packages/db/package.json': JSON.stringify({ name: '@repo/db', main: 'dist/index.js', types: 'dist/index.d.ts' }),
    'packages/db/src/index.ts': "import { Pool } from 'pg';\nexport declare const pool: Pool;\n",
    'packages/api/package.json': JSON.stringify({ name: '@repo/api', dependencies: { '@repo/db': '*' } }),
    'packages/api/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
    'packages/api/query.ts':
      "import { pool } from '@repo/db';\nexport async function find(email: string) {\n" + lowerEmailQuery + '}\n',
    ...extra,
  };
}

test('an import of an unbuilt workspace package resolves to its source, so typed query rules report', (context) => {
  const root = project(context, workspaceWithUnbuiltDatabasePackage());
  const run = loadwise(path.join(root, 'packages/api'), 'perf', '--json', '--engine', 'js');
  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(
    JSON.parse(run.stdout).findings.map(({ line, ruleId }: Finding) => [line, ruleId]),
    [
      [3, 'index-unusable-expression'],
      [3, 'sql-select-star-in-query'],
    ],
  );
});

test('a package outside the workspace with a missing entry stays unresolved', (context) => {
  const root = project(
    context,
    workspaceWithUnbuiltDatabasePackage({
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/api'] }),
    }),
  );
  const run = loadwise(path.join(root, 'packages/api'), 'perf', '--json', '--engine', 'js');
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).findings, []);
});

test('a query client the package depends on, directly or through a workspace package, prints a note when missing', (context) => {
  const root = project(context, {
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'packages/prisma/package.json': JSON.stringify({ name: '@repo/prisma', dependencies: { '@prisma/client': '5' } }),
    'packages/api/package.json': JSON.stringify({
      name: '@repo/api',
      dependencies: { '@repo/prisma': 'workspace:*', knex: '3', mongoose: '8', express: '4', '@n8n/typeorm': '0' },
    }),
    'packages/api/tsconfig.json': JSON.stringify({ include: ['*.ts'] }),
    'packages/api/node_modules/mongoose/package.json': '{"name":"mongoose"}',
    'packages/api/index.ts': 'export const one = 1;\n',
  });
  const run = loadwise(path.join(root, 'packages/api'), 'perf', '--json', '--engine', 'js');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /Note: knex is a dependency but not installed/);
  assert.match(run.stderr, /Note: @prisma\/client is a dependency but not installed/);
  // TypeORM receivers are still recognised from declarations, so its note does not claim the checks
  // were skipped.
  assert.match(
    run.stderr,
    /Note: @n8n\/typeorm is a dependency but not installed; its checks run with reduced precision from declarations until `npm install`\.\n/,
  );
  assert.doesNotMatch(run.stderr, /mongoose|express/);
});

test('e2e sources and folders are test sources; similar names are not', () => {
  const { isTestSource }: typeof ReviewContext = require('../../lib/performance/review-context.cjs');
  for (const file of ['src/booking.e2e.ts', 'src/booking.e2e-ee.ts', 'src/booking.e2e-spec.ts', 'apps/api/e2e/x.ts']) {
    assert.equal(isTestSource(path.resolve(file)), true, file);
  }
  for (const file of ['src/e2ee.ts', 'src/e2e-keys.ts', 'src/e2eHelpers/x.ts']) {
    assert.equal(isTestSource(path.resolve(file)), false, file);
  }
});

test('maint resolves path aliases of the ancestor config when scanning a folder without one', (context) => {
  const root = project(context, {
    'package.json': '{"name":"outline-like"}',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@server/*': ['./server/*'] } },
      include: ['server/**/*.ts'],
    }),
    'server/index.ts': "import { send } from '@server/emails/send';\nsend();\n",
    'server/emails/send.ts': 'export function send() {}\n',
    'server/emails/orphan.ts': 'export function orphan() {}\n',
  });
  const run = loadwise(path.join(root, 'server'), 'maint', '--json', '--include-contextual');
  const unreferenced = JSON.parse(run.stdout)
    .findings.filter(({ ruleId }: Finding) => ruleId === 'unreferenced-file')
    .map(({ file }: Finding) => file);
  assert.deepEqual(unreferenced, ['emails/orphan.ts']);
});
