import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { createResolver } from '../../lib/maintainability/inputs.js';
import { validateDataAccess, checkDataAccess } from '../../lib/maintainability/data-access.js';
import { relativeName } from '../../lib/maintainability/project.js';
import type { Finding } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';

const defaultRule = { modules: ['pg', '@prisma/client', './generated'], allowIn: ['reviewed'] };
const defaultFiles: FileMap = {
  'generated/db.ts': 'export const db = {};',
  'generated-other/db.ts': 'export const db = {};',
};

function findings(
  source: string,
  rule = defaultRule,
  extraFiles = defaultFiles,
  compilerOptions: ts.CompilerOptions = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-access-'));
  try {
    const files = { 'main.ts': source, ...extraFiles };
    for (const [name, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), contents);
    }
    const resolve = createResolver(root, new Set(Object.keys(files)));
    const sourceFile = ts.createSourceFile(path.join(root, 'main.ts'), source, ts.ScriptTarget.Latest, true);
    return checkDataAccess(sourceFile, 'main.ts', resolve, validateDataAccess(rule, relativeName), compilerOptions);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('validates literal module names, aliases and portable in-project paths', () => {
  const validated = validateDataAccess(
    {
      modules: ['pg', 'pg', '@scope/driver', '@/database', '#models', 'node:sqlite', './generated'],
      allowIn: ['services/data', 'jobs/maintenance.ts'],
    },
    relativeName,
  );
  assert.deepEqual([...validated.modules], ['pg', '@scope/driver', '@/database', '#models', 'node:sqlite']);
  assert.deepEqual(validated.allowedPaths, ['services/data', 'jobs/maintenance.ts']);
  assert.deepEqual(validated.localPaths, ['generated']);
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
    assert.throws(() => validateDataAccess(invalid, relativeName), /dataAccess|project-relative/);
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
  assert.ok(report.every((finding) => finding.ruleId === 'data-access-boundary'));
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

test('inline type-only specifiers preserve runtime side effects in verbatimModuleSyntax projects', () => {
  const source = [
    "import type { Driver } from 'driver';",
    "import { type Inline } from 'driver';",
    "export type { Model } from 'driver';",
    "export { type Forwarded } from 'driver';",
  ].join('\n');
  const rule = { modules: ['driver'], allowIn: ['reviewed'] };
  assert.deepEqual(findings(source, rule, {}), []);
  assert.deepEqual(
    findings(source, rule, {}, { verbatimModuleSyntax: true }).map((finding) => finding.line),
    [2, 4],
  );
});

test('the CLI loads dataAccess from the config file and fails the default contract check', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-access-cli-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(
    path.join(root, 'app.ts'),
    "import { Pool } from 'pg';\nimport { pool } from './data/db';\nexport const pools = [Pool, pool];\n",
  );
  fs.writeFileSync(path.join(root, 'data', 'db.ts'), "import { Pool } from 'pg';\nexport const pool = Pool;\n");
  fs.writeFileSync(
    path.join(root, 'policy.json'),
    JSON.stringify({ dataAccess: { modules: ['pg'], allowIn: ['data'] } }),
  );
  const cli = path.join(import.meta.dirname, '..', '..', 'bin', 'loadwise.js');
  const run = spawnSync(process.execPath, [cli, 'maint', root, '--config', path.join(root, 'policy.json'), '--json'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(
    JSON.parse(run.stdout).findings.map((finding: Finding) => [finding.file, finding.ruleId]),
    [['app.ts', 'data-access-boundary']],
  );
});

test('ambient declarations in a restricted folder do not place the external module implementation there', () => {
  const declarations = {
    'protected/ambient.d.ts': "declare module 'external-driver' { export function read(): number }",
  };
  const rule = { modules: ['./protected'], allowIn: ['reviewed'] };
  assert.deepEqual(findings("import {read} from 'external-driver'; read();", rule, declarations), []);
});
