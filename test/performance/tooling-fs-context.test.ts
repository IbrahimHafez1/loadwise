import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Finding } from '../../lib/shared/types.js';
import { reasonOf } from '../types/finding-reason.js';
import * as nativeRuntime from '../../lib/performance/native-runtime.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const fsRule = 'node-sync-fs-in-async';
const generator = [
  "import { writeFileSync } from 'node:fs';",
  'export async function emitSchema() {',
  '  await Promise.resolve();',
  "  writeFileSync('schema.graphql', 'type Query { ready: Boolean }');",
  '}',
].join('\n');
const launcher = [
  "import { emitSchema as generate } from './schema.js';",
  'function startServer() {}',
  'if (!process.env.GENERATE_GQL_SCHEMA) {',
  '  startServer();',
  '} else {',
  '  generate();',
  '}',
].join('\n');

function scanFixture(
  context: TestContext,
  { main = launcher, tool = generator, extra = {}, privatePackage = true, explicit = false, engine = 'js' } = {},
) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-fs-tooling-test-'));
  const manifest = { private: privatePackage, scripts: { schema: 'cross-env GENERATE_GQL_SCHEMA=true node main.js' } };
  const files = {
    'package.json': JSON.stringify(manifest),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', types: [] },
      include: ['*.ts'],
    }),
    'main.ts': main,
    'schema.ts': tool,
    ...extra,
  };
  context.after(() => {
    for (const name of Object.keys(files)) fs.rmSync(path.join(root, name), { force: true });
    fs.rmdirSync(root);
  });
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  const input = explicit ? ['main.ts', 'schema.ts'] : ['-p', 'tsconfig.json'];
  const run = spawnSync(
    process.execPath,
    [bin, 'perf', '--engine', engine, ...input, '--json', '--include-contextual'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.ok(run.status !== null && [0, 1].includes(run.status), run.stderr);
  return JSON.parse(run.stdout).findings.filter((finding: Finding) => finding.ruleId === fsRule);
}

test('filesystem work in a schema generator bound only to the private tooling branch is contextual', (context) => {
  const findings = scanFixture(context);
  assert.equal(findings.length, 1);
  assert.match(reasonOf(findings[0]), /schema-generation branch/);
});

test('the native engine classifies the same full-project schema fixture', (context) => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) return context.skip('Native requires Node 22.13+');
  try {
    nativeRuntime.executable();
  } catch {
    return context.skip('Optional native compiler is absent');
  }
  const findings = scanFixture(context, { engine: 'native' });
  assert.equal(findings.length, 1);
  assert.match(reasonOf(findings[0]), /schema-generation branch/);
});

test('partial input and public packages retain visible filesystem findings', (context) => {
  for (const options of [{ explicit: true }, { privatePackage: false }]) {
    const findings = scanFixture(context, options);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].contextualReason, undefined);
  }
});

test('ordinary, aliased, or escaping consumers retain visible filesystem findings', (context) => {
  for (const extra of [
    {
      'handler.ts': "import { emitSchema } from './schema.js'; export async function handle() { await emitSchema(); }",
    },
    { 'handler.ts': "import { emitSchema as tool } from './schema.js'; export const callback = tool;" },
    { 'barrel.ts': "export * from './schema.js';" },
    { 'barrel.ts': "export { emitSchema as generator } from './schema.js';" },
    { 'namespace.ts': "import * as tooling from './schema.js'; export const callback = tooling.emitSchema;" },
    { 'dynamic.ts': "void import('./schema.js').then(({ emitSchema }) => emitSchema());" },
  ]) {
    const findings = scanFixture(context, { extra });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].contextualReason, undefined);
  }
});

test('a runtime flag used inside a callback or without a normal branch is not a tooling entry', (context) => {
  for (const main of [
    "import { emitSchema } from './schema.js'; if (process.env.GENERATE_GQL_SCHEMA) emitSchema();",
    "import { emitSchema } from './schema.js'; export function run() { if (process.env.GENERATE_GQL_SCHEMA) emitSchema(); else startServer(); }",
    `${launcher}\nstartServer();`,
  ]) {
    const findings = scanFixture(context, { main });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].contextualReason, undefined);
  }
});
