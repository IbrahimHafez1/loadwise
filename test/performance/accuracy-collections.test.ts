import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { withProgram } from './helpers.js';
import { analyzeFile } from '../../lib/performance/analyze.js';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';
import { sourceFileOf } from '../types/program-files.js';

function lintAs(fileName: string, source: string, files: FileMap = {}) {
  return withProgram('export {};', { [fileName]: source, ...files }, (program: ProgramAdapter) =>
    analyzeFile(program, sourceFileOf(program, path.join(import.meta.dirname, 'virtual-project', fileName))),
  );
}

function summary(findings: Finding[], ruleId: string) {
  return findings
    .filter((finding: Finding) => finding.ruleId === ruleId)
    .map((finding: Finding) => [finding.line, Boolean(finding.contextualReason)]);
}

const membershipSource =
  'export async function pick(rows: string[], repo: { find(): Promise<string[]> }) { const ids = await repo.find();\n  return rows.filter((row) => ids.includes(row));\n}';
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

test('helpers inside test directories without a spec or test suffix are contextual', () => {
  for (const fileName of ['tests/service.ts', 'test/helpers/db.ts', 'src/__tests__/factory.ts']) {
    assert.deepEqual(summary(lintAs(fileName, membershipSource), 'array-repeated-membership'), [[2, true]], fileName);
  }
  assert.deepEqual(summary(lintAs('src/testing/service.ts', membershipSource), 'array-repeated-membership'), [
    [2, false],
  ]);
});

test('a constant allowlist of plain values is a cheap lookup up to a bounded length', () => {
  const list = (count: number) => Array.from({ length: count }, (_, index) => `'field${index}'`).join(', ');
  const source = (count: number, extra = '') =>
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
  const use = (expression: string) =>
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

test('iterating a short imported constant list, lookup table or decorator metadata is bounded', () => {
  const members = Array.from({ length: 18 }, (_, index) => `'item${index}'`).join(', ');
  const files = {
    'catalog.ts': `export const CATALOG = [${members}];\nexport const TABLE: Record<string, string[]> = { a: ['x', 'y'], b: ['z'] };\n`,
  };
  const membership = (setup: string, input: string) =>
    `import { CATALOG, TABLE } from './catalog.js';\ndeclare const reflector: { getAllAndOverride<T>(key: string, targets: unknown[]): T };\nexport function check(held: string[], name: string) {\n  ${setup}\n  return ${input}.every((key) => held.includes(key));\n}`;
  const reported = (setup: string, input: string) =>
    summary(lintAs('service.ts', membership(setup, input), files), 'array-repeated-membership').length;
  assert.equal(reported('', 'CATALOG'), 0);
  assert.equal(reported('', 'TABLE[name]'), 0);
  assert.equal(reported('const required = reflector.getAllAndOverride<string[]>("keys", []) ?? [];', 'required'), 0);
  assert.equal(reported('', 'held.slice(1)'), 1);
});

test('only calls before a lookup count as possibly changing a small array', () => {
  const source = (before: string, after: string) =>
    `declare function inspect(list: string[]): void;\nexport function check(known: string[]) {\n  const wanted = ['a', 'b', 'c'];\n  ${before}\n  const found = wanted.filter((item) => known.includes(item));\n  ${after}\n  return found;\n}`;
  const reported = (before: string, after: string) =>
    summary(lintAs('service.ts', source(before, after)), 'array-repeated-membership').length;
  assert.equal(reported('', 'inspect(wanted);'), 0);
  assert.equal(reported('inspect(wanted);', ''), 1);
  assert.equal(reported('', 'wanted.push("d");'), 1);
});

test('lookups are default findings over known data sources and contextual when the array size is unknown', () => {
  const reasonFor = (setup: string) =>
    lintAs(
      'service.ts',
      `declare const repo: { findMany(): Promise<string[]>; query(): Promise<string[]> };\ndeclare function opaque(): Promise<string[]>;\nexport async function pick(rows: string[], param: string[], request: { body: { ids: string[] } }) {\n  ${setup}\n  return rows.filter((row) => ids.includes(row));\n}`,
    ).find((finding: Finding) => finding.ruleId === 'array-repeated-membership')?.contextualReason;
  const unknown = 'array size unknown; review if it can hold more than a few dozen items';
  assert.equal(reasonFor('const ids = await repo.findMany();'), undefined);
  assert.equal(reasonFor('const ids = (await repo.query()).filter(Boolean);'), undefined);
  assert.equal(reasonFor('const ids = request.body.ids;'), undefined);
  assert.equal(reasonFor('const ids = JSON.parse("[]") as string[];'), undefined);
  assert.equal(reasonFor('const ids = Array.from(new Set((await repo.findMany()).map((id) => id)));'), undefined);
  assert.equal(reasonFor('const [ids] = await Promise.all([repo.findMany()]);'), undefined);
  assert.equal(reasonFor('const ids = param;'), unknown);
  assert.equal(reasonFor('const ids = await opaque();'), unknown);
});

test('lookups on receivers named like small configuration lists are contextual only when the size is unknown', () => {
  const smallList = "The receiver's name suggests a small configuration list; dismiss if it stays a handful of items.";
  const membershipReason = (name: string, declaration = `const ${name} = param;`) =>
    lintAs(
      'service.ts',
      `declare const repo: { findMany(): Promise<string[]> };\nexport async function pick(rows: string[], param: string[]) {\n  ${declaration}\n  return rows.filter((row) => ${name}.includes(row));\n}`,
    ).find((finding: Finding) => finding.ruleId === 'array-repeated-membership')?.contextualReason;
  for (const name of ['filters', 'options', 'props', 'columns', 'fields', 'roles', 'permissions', 'tabs', 'steps']) {
    assert.equal(membershipReason(name), smallList, name);
  }
  assert.equal(membershipReason('ids'), 'array size unknown; review if it can hold more than a few dozen items');
  assert.equal(membershipReason('roles', 'const roles = await repo.findMany();'), undefined);

  const findReason = (name: string) =>
    lintAs(
      'service.ts',
      `export function link(${name}: { id: string }[], rows: { id: string }[]) {\n  return rows.map((row) => ${name}.find((item) => item.id === row.id));\n}`,
    ).find((finding: Finding) => finding.ruleId === 'array-repeated-find')?.contextualReason;
  assert.equal(findReason('columns'), smallList);
  assert.equal(findReason('items'), undefined);
});
