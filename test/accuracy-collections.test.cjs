'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { withProgram } = require('./helpers.cjs');
const { analyzeFile } = require('../lib/analyze.cjs');

function lintAs(fileName, source, files = {}) {
  return withProgram('export {};', { [fileName]: source, ...files }, (program) =>
    analyzeFile(program, program.getSourceFile(path.join(__dirname, 'virtual-project', fileName))),
  );
}

function summary(findings, ruleId) {
  return findings
    .filter((finding) => finding.ruleId === ruleId)
    .map((finding) => [finding.line, Boolean(finding.contextualReason)]);
}

const membershipSource =
  'export function pick(rows: string[], ids: string[]) {\n  return rows.filter((row) => ids.includes(row));\n}';
const findSource =
  'export function link(items: { id: string }[], rows: { id: string }[]) {\n  return rows.map((row) => items.find((item) => item.id === row.id));\n}';

test('lookups stay visible in server sources and become contextual in tests, seeds and client UI', () => {
  assert.deepEqual(summary(lintAs('service.ts', membershipSource), 'array-repeated-membership'), [[2, false]]);
  assert.deepEqual(summary(lintAs('service.ts', findSource), 'array-repeated-find'), [[2, false]]);
  for (const fileName of [
    'users.spec.ts',
    'users.e2e-spec.ts',
    'users.itest.ts',
    'seeds/run.ts',
    'clinic.seed.ts',
    'Panel.tsx',
  ]) {
    assert.deepEqual(summary(lintAs(fileName, membershipSource), 'array-repeated-membership'), [[2, true]], fileName);
    assert.deepEqual(summary(lintAs(fileName, findSource), 'array-repeated-find'), [[2, true]], fileName);
  }
});

test('a project that lives under a test directory is not treated as a test source', () => {
  assert.deepEqual(summary(lintAs('tests/service.ts', membershipSource), 'array-repeated-membership'), [[2, false]]);
});

test('a constant allowlist of plain values is a cheap lookup up to a bounded length', () => {
  const list = (count) => Array.from({ length: count }, (_, index) => `'field${index}'`).join(', ');
  const source = (count, extra = '') =>
    `const ALLOWED = [${list(count)}];\n${extra}export function drop(keys: string[]) {\n  return keys.filter((key) => !ALLOWED.includes(key));\n}`;
  assert.deepEqual(summary(lintAs('service.ts', source(10)), 'array-repeated-membership'), []);
  assert.deepEqual(summary(lintAs('service.ts', source(17)), 'array-repeated-membership').length, 1);
  assert.deepEqual(
    summary(
      lintAs('service.ts', source(10, 'export function grow(field: string) { ALLOWED.push(field); }\n')),
      'array-repeated-membership',
    ).length,
    1,
  );
  const objects = `const ALLOWED = [${Array.from({ length: 10 }, () => '{}').join(', ')}];\nexport function drop(keys: object[]) {\n  return keys.filter((key) => !ALLOWED.includes(key));\n}`;
  assert.deepEqual(summary(lintAs('service.ts', objects), 'array-repeated-membership').length, 1);
});

test('values of a small enum are a bounded lookup, also across an import', () => {
  const enumSource =
    "export enum Role { A = 'a', B = 'b', C = 'c', D = 'd', E = 'e', F = 'f', G = 'g', H = 'h', I = 'i' }\nexport enum Level { A, B, C, D, E, F, G, H, I }\n";
  const use = (expression) =>
    `import { Role, Level } from './roles.js';\nexport function valid(items: string[]) {\n  const known = ${expression};\n  return items.filter((item) => known.includes(item));\n}`;
  const files = { 'roles.ts': enumSource };
  assert.deepEqual(
    summary(lintAs('service.ts', use('Object.values(Role) as string[]'), files), 'array-repeated-membership'),
    [],
  );
  assert.equal(
    summary(
      lintAs('service.ts', use('Object.values(Level) as unknown as string[]'), files),
      'array-repeated-membership',
    ).length,
    1,
  );
  assert.equal(
    summary(lintAs('service.ts', use('Object.keys(Object.fromEntries([]))'), files), 'array-repeated-membership')
      .length,
    1,
  );
});

const startupHook = [
  "import { readFileSync, readdirSync } from 'node:fs';",
  'export class Runner {',
  '  async onApplicationBootstrap() {',
  "    for (const file of readdirSync('migrations')) readFileSync(file);",
  '  }',
  '  async handle(file: string) {',
  '    readFileSync(file);',
  '  }',
  '}',
].join('\n');

test('synchronous fs in a startup hook is contextual, in a request method it is not', () => {
  assert.deepEqual(summary(lintAs('runner.ts', startupHook), 'node-sync-fs-in-async'), [
    [4, true],
    [4, true],
    [7, false],
  ]);
});

test('synchronous calls in test sources and operator tooling are contextual unless repeated', () => {
  const direct =
    "import { writeFileSync } from 'node:fs';\nexport async function save(file: string) {\n  writeFileSync(file, '');\n}";
  const repeated =
    "import { writeFileSync } from 'node:fs';\nexport async function save(files: string[]) {\n  for (const file of files) writeFileSync(file, '');\n}";
  assert.deepEqual(summary(lintAs('src/files.ts', direct), 'node-sync-fs-in-async'), [[3, false]]);
  for (const fileName of [
    'src/files.spec.ts',
    'src/files.db-spec.ts',
    'scripts/save.ts',
    'deploy/release.mjs',
    'src/database/commands/clean.command.ts',
  ]) {
    assert.deepEqual(summary(lintAs(fileName, direct), 'node-sync-fs-in-async'), [[3, true]], fileName);
  }
  assert.deepEqual(summary(lintAs('scripts/save.ts', repeated), 'node-sync-fs-in-async'), [[3, false]]);
  assert.deepEqual(summary(lintAs('src/files.spec.ts', repeated), 'node-sync-fs-in-async'), [[3, true]]);
  const crypto =
    "import { generateKeyPairSync } from 'node:crypto';\nexport async function make() {\n  return generateKeyPairSync('rsa', { modulusLength: 2048 });\n}";
  assert.deepEqual(summary(lintAs('src/key.ts', crypto), 'node-sync-crypto-in-async'), [[3, false]]);
  assert.deepEqual(summary(lintAs('src/key.itest.ts', crypto), 'node-sync-crypto-in-async'), [[3, true]]);
});
