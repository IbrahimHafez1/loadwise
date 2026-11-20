'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { lint } = require('./helpers.cjs');
const { validateDataAccess } = require('../lib/data-access.cjs');

const policyPath = path.join(__dirname, 'virtual-project', 'policy.json');
const defaultRule = { modules: ['pg', '@prisma/client', './generated'], allowIn: ['reviewed'] };
const files = {
  'generated/db.ts': 'export const db = {};',
  'generated-other/db.ts': 'export const db = {};',
};

function findings(source, rule = defaultRule, extraFiles = files) {
  return lint(source, extraFiles, { dataAccess: validateDataAccess(rule, policyPath) }).filter(
    (finding) => finding.ruleId === 'data-access-boundary',
  );
}

test('validates literal module names, aliases and portable in-project paths', () => {
  const validated = validateDataAccess(
    {
      modules: ['pg', 'pg', '@scope/driver', '@/database', '#models', 'node:sqlite', './generated'],
      allowIn: ['services/data', 'jobs/maintenance.ts'],
    },
    policyPath,
  );
  assert.deepEqual([...validated.modules], ['pg', '@scope/driver', '@/database', '#models', 'node:sqlite']);
  assert.equal(validated.allowedPaths.length, 2);
  assert.equal(validated.localPaths.length, 1);
  for (const invalid of [
    null,
    [],
    {},
    { ...defaultRule, typo: true },
    { ...defaultRule, allowIn: [] },
    { ...defaultRule, modules: ['pg/*'] },
    { ...defaultRule, modules: ['pg/../other'] },
    { ...defaultRule, modules: [' pg'] },
    { ...defaultRule, modules: ['@scope/'] },
    { ...defaultRule, modules: ['https://example.test/db'] },
    { ...defaultRule, modules: [false] },
    { ...defaultRule, allowIn: ['../outside'] },
    { ...defaultRule, modules: ['./../outside'] },
    { ...defaultRule, allowIn: ['/absolute'] },
    { ...defaultRule, allowIn: ['D:other'] },
    { ...defaultRule, allowIn: ['C:\\absolute'] },
    { ...defaultRule, allowIn: ['\\\\server\\other'] },
  ])
    assert.throws(() => validateDataAccess(invalid, policyPath), /dataAccess/);
});

test('flags runtime static imports, reexports, dynamic literal imports and Node require calls', () => {
  const report = findings(
    [
      "import { Pool } from 'pg';",
      "import 'pg/lib/client';",
      "export * from '@prisma/client';",
      "export { Pool as DatabasePool } from 'pg';",
      "import driver = require('pg');",
      "const client = require('@prisma/client');",
      "const future = import('pg');",
      'const workers = import(`./generated/db.js`);',
      "import { db } from './generated/db.js';",
    ].join('\n'),
  );
  assert.deepEqual(
    report.map((finding) => finding.line),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('policy permits types, approved import sites, shadowed require and distinct module names', () => {
  const source = [
    "import type { Pool } from 'pg';",
    "import { type Client } from 'pg';",
    "export type { PrismaClient } from '@prisma/client';",
    "export { type Pool as PoolType } from 'pg';",
    "import 'pg-cursor';",
    "import '@prisma/client-utils';",
    "import { db } from './generated-other/db.js';",
    "function local(require: (name: string) => {}) { return require('pg'); }",
    'declare const driverName: string;',
    'import(driverName);',
    "const metadata = 'pg';",
  ].join('\n');
  assert.deepEqual(findings(source), []);
  assert.deepEqual(findings("import 'pg';", { ...defaultRule, allowIn: ['main.ts'] }), []);
  assert.equal(findings("import 'pg';", { ...defaultRule, allowIn: ['main'] }).length, 1);
});

test('uses the resolved file for local restrictions and respects file-versus-directory precedence', () => {
  const modules = { 'store.ts': 'export const value = 1;', 'store/index.ts': 'export const value = 2;' };
  const source = ["import { value } from './store';", "export { value as nested } from './store/index.js';"].join('\n');
  assert.deepEqual(
    findings(source, { modules: ['./store'], allowIn: ['reviewed'] }, modules).map((finding) => finding.line),
    [2],
  );
  assert.deepEqual(
    findings(source, { modules: ['./store.ts'], allowIn: ['reviewed'] }, modules).map((finding) => finding.line),
    [1],
  );
});

test('ambient declarations in a restricted folder do not place the external module implementation there', () => {
  const declarations = {
    'protected/ambient.d.ts': "declare module 'external-driver' { export function read(): number }",
  };
  const rule = { modules: ['./protected'], allowIn: ['reviewed'] };
  assert.deepEqual(findings("import {read} from 'external-driver'; read();", rule, declarations), []);
});

test('inline type-only specifiers preserve runtime side effects in verbatimModuleSyntax projects', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-boundary-'));
  const source = [
    "import type { Driver } from 'driver';",
    "import { type Inline } from 'driver';",
    "export type { Model } from 'driver';",
    "export { type Forwarded } from 'driver';",
  ].join('\n');
  const write = (name, contents) => fs.writeFileSync(path.join(directory, name), contents);
  try {
    write('app.ts', source);
    write('policy.json', JSON.stringify({ dataAccess: { modules: ['driver'], allowIn: ['reviewed'] } }));
    const cli = path.join(__dirname, '..', 'bin', 'backend-perf-check.cjs');
    for (const verbatimModuleSyntax of [false, true]) {
      write(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', verbatimModuleSyntax },
          files: ['app.ts'],
        }),
      );
      const native = process.env.PERF_CHECK_TEST_NATIVE === '1' ? ['--native'] : [];
      const run = spawnSync(
        process.execPath,
        [cli, ...native, '-p', 'tsconfig.json', '--policy', 'policy.json', '--json'],
        { cwd: directory, encoding: 'utf8' },
      );
      assert.equal(run.status, verbatimModuleSyntax ? 1 : 0, run.stderr);
      assert.deepEqual(
        JSON.parse(run.stdout).findings.map((finding) => finding.line),
        verbatimModuleSyntax ? [2, 4] : [],
      );
    }
  } finally {
    for (const name of ['app.ts', 'policy.json', 'tsconfig.json'])
      fs.rmSync(path.join(directory, name), { force: true });
    fs.rmdirSync(directory);
  }
});
