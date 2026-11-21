'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
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
  context,
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
  assert.ok([0, 1].includes(run.status), run.stderr);
  return JSON.parse(run.stdout).findings.filter((finding) => finding.ruleId === fsRule);
}

test('filesystem work in a schema generator bound only to the private tooling branch is contextual', (context) => {
  const findings = scanFixture(context);
  assert.equal(findings.length, 1);
  assert.match(findings[0].contextualReason, /schema-generation branch/);
});

test('the native engine classifies the same full-project schema fixture', (context) => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) return context.skip('Native requires Node 22.13+');
  try {
    require('../../lib/performance/native-runtime.cjs').executable();
  } catch {
    return context.skip('Optional native compiler is absent');
  }
  const findings = scanFixture(context, { engine: 'native' });
  assert.equal(findings.length, 1);
  assert.match(findings[0].contextualReason, /schema-generation branch/);
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
