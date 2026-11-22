'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const root = path.resolve(__dirname, '../..');
function run(args, cwd = root) {
  return spawnSync(process.execPath, [bin, 'perf', ...args], { cwd, encoding: 'utf8' });
}

function fixture(context, files) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'backend-perf-cli-'));
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents);
  context.after(() => {
    for (const name of Object.keys(files)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return directory;
}

test('CLI detects all sample problems and accepts the indexed implementation', () => {
  const slow = run(['examples/slow.ts', '--json']);
  assert.equal(slow.status, 1, slow.stderr);
  const result = JSON.parse(slow.stdout);
  assert.equal(result.scannedFiles, 1);
  assert.deepEqual(
    result.findings.map((item) => item.ruleId),
    ['array-repeated-membership', 'array-repeated-find', 'reduce-copy-accumulator'],
  );
  assert.ok(result.findings.every((item) => item.file === 'examples/slow.ts' && item.line && item.column));
  const clean = run(['examples/indexed.ts']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /0 finding/);
});

test('examples agree on duplicate keys, missing customers, NaN and empty inputs', () => {
  const implementations = ['slow', 'indexed'].map((name) => {
    const code = fs.readFileSync(path.join(root, 'examples', name + '.ts'), 'utf8');
    const compiled = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const exports = {};
    new Function('exports', compiled.outputText)(exports);
    return exports.visibleNames;
  });
  const ids = [2, 7, Number.NaN, 2, 5, 11];
  const customers = [
    { id: 2, name: 'first' },
    { id: 2, name: 'later' },
    { id: Number.NaN, name: 'skip' },
  ];
  for (const visible of implementations) {
    assert.deepEqual(visible([], [], { body: { allowed: [] } }), []);
    assert.deepEqual(
      visible(
        ids.map((customerId, id) => ({ id, customerId })),
        customers,
        { body: { allowed: [2, 7, Number.NaN] } },
      ),
      ['first', 'Unknown', 'Unknown', 'first'],
    );
  }
});

test('default solution follows references and honors JS config inputs and rule exclusions', (context) => {
  const directory = fixture(context, {
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './child.json' }] }),
    'child.json': JSON.stringify({ compilerOptions: { allowJs: true, target: 'ES2022' }, files: ['server.cjs'] }),
    'server.cjs': 'const {readFileSync: read} = require("node:fs"); async function load() { return read("demo"); }',
    'excluded.ts': 'const !!!',
  });
  const finding = run(['--json'], directory);
  assert.equal(finding.status, 1, finding.stderr);
  assert.equal(JSON.parse(finding.stdout).findings[0].ruleId, 'node-sync-fs-in-async');
  const ignored = run(['-p', '.', '--ignore', 'node-sync-fs-in-async', '--json'], directory);
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(JSON.parse(ignored.stdout), { scannedFiles: 1, findings: [] });
});

test('bad code, missing files, invalid configs and unknown rules fail with exit 2', (context) => {
  const directory = fixture(context, { 'bad.ts': 'const !!!', 'config.json': '{ "files": 5 }' });
  for (const args of [['bad.ts'], ['missing.ts'], ['-p', 'config.json'], ['--ignore', 'typo'], ['-p', '.', 'bad.ts']]) {
    const result = run(args, directory);
    assert.equal(result.status, 2, result.stdout);
    assert.ok(result.stderr.trim());
  }
});

test('contextual findings are counted by default and retrievable at their original locations', (context) => {
  const directory = fixture(context, {
    'service.js': [
      "const { readFileSync } = require('node:fs');",
      'exports.handle = async function () {',
      '  // backend-perf-reviewed node-sync-fs-in-async -- Read a one-time fixture.',
      "  readFileSync('fixture');",
      '};',
    ].join('\n'),
  });
  const checked = run(['service.js', '--json'], directory);
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), { scannedFiles: 1, findings: [], contextualFindingCount: 1 });
  const full = run(['service.js', '--json', '--include-contextual'], directory);
  assert.equal(full.status, 1, full.stderr);
  const { findings, contextualFindingCount } = JSON.parse(full.stdout);
  assert.equal(contextualFindingCount, 1);
  assert.equal(findings[0].line, 4);
  assert.match(findings[0].contextualReason, /one-time fixture/);
  const contract = run(['service.js', '--include-contextual', '--fail-on', 'contract'], directory);
  assert.equal(contract.status, 0, contract.stderr);
  const ignored = run(['service.js', '--json', '--include-contextual', '--ignore', 'node-sync-fs-in-async'], directory);
  assert.deepEqual(JSON.parse(ignored.stdout), { scannedFiles: 1, findings: [] });
});

test('help respects option terminators and cannot hide a missing option value', (context) => {
  const directory = fixture(context, { '--help': '{"resourceSpans":[]}' });
  const trace = run(['traces', '--json', '--', '--help'], directory);
  assert.equal(trace.status, 0, trace.stderr);
  assert.equal(JSON.parse(trace.stdout).scannedSpans, 0);
  assert.equal(run(['--policy', '--help'], directory).status, 2);
  for (const args of [['--help'], ['plan', '-h'], ['polyglot', '--help'], ['traces', '-h']]) {
    const help = run(args, directory);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
  }
});

test('a shared file can resolve to a built-in array in just one referenced project', (context) => {
  const child = (pathKey) =>
    JSON.stringify({
      compilerOptions: { target: 'ES2022', baseUrl: '.', paths: { models: [pathKey] } },
      files: ['service.ts'],
    });
  const directory = fixture(context, {
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [{ path: './custom.json' }, { path: './array.json' }, { path: './duplicate.json' }],
    }),
    'custom.json': child('custom.d.ts'),
    'array.json': child('array.d.ts'),
    'duplicate.json': child('array.d.ts'),
    'custom.d.ts': 'export interface Labels { includes(id: string): boolean }',
    'array.d.ts': 'export type Labels = string[];',
    'service.ts':
      "import type { Labels } from 'models'; export async function filter(ids: string[], db: { find(): Promise<Labels> }) { const labels = await db.find(); return ids.filter(id => labels.includes(id)); }",
  });
  const checked = run(['--json'], directory);
  assert.equal(checked.status, 1, checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.scannedFiles, 1);
  assert.deepEqual(
    result.findings.map((finding) => finding.ruleId),
    ['array-repeated-membership'],
  );
});

test('trace CLI returns 1 at the threshold, 0 above it and 2 for invalid input', (context) => {
  const example = path.join(root, 'examples/repeated-db.otlp.json');
  const flagged = run(['traces', example, '--json']);
  assert.equal(flagged.status, 1, flagged.stderr);
  const result = JSON.parse(flagged.stdout);
  assert.equal(result.findings[0].count, 5);
  assert.equal(result.findings[0].system, 'mongodb');
  assert.equal(run(['traces', example, '--threshold', '6']).status, 0);
  assert.equal(run(['traces', example, '--threshold', '1']).status, 2);
  const directory = fixture(context, { 'invalid.json': 'SECRET-SENTINEL' });
  const invalid = run(['traces', 'invalid.json'], directory);
  assert.equal(invalid.status, 2);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /SECRET-SENTINEL/);
});

test('plan CLI recognizes both engines and rejects estimates', (context) => {
  for (const [file, engine] of [
    ['postgres-plan.json', 'postgresql'],
    ['mongo-plan.json', 'mongodb'],
  ]) {
    const result = run(['plan', 'examples/' + file, '--json']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).engine, engine);
  }
  const directory = fixture(context, {
    'indexed.json': JSON.stringify([{ Plan: { 'Node Type': 'Index Scan', 'Actual Rows': 1, 'Actual Loops': 1 } }]),
    'estimate.json': JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 50 } }]),
  });
  assert.equal(run(['plan', 'indexed.json'], directory).status, 0);
  assert.equal(run(['plan', 'estimate.json'], directory).status, 2);
});

test('JavaScript a tsconfig leaves out without allowJs is named in a note on both engines', (context) => {
  const directory = fixture(context, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] } }),
    'app.ts': 'export const app = 1;\n',
    'report.js': 'module.exports = {};\n',
    'eslint.config.js': 'module.exports = [];\n',
  });
  for (const engine of ['js', 'native']) {
    const result = run(['--engine', engine, '--json'], directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /skip 1 JavaScript file\(s\) in \. \(report\.js\) because .*"allowJs"/);
  }
  fs.writeFileSync(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { types: [], allowJs: true } }),
  );
  assert.doesNotMatch(run(['--json'], directory).stderr, /allowJs/);
});

test('an uninstalled Mongoose loaded with require() is recognised like an import', (context) => {
  const loop =
    'export async function load(ids: string[]) {\n  const out = [];\n  for (const id of ids) out.push(await User.findById(id));\n  return out;\n}\n';
  const sources = {
    imported: "import mongoose from 'mongoose';\nconst User = mongoose.model('User', new mongoose.Schema({}));\n",
    required: "const mongoose = require('mongoose');\nconst User = mongoose.model('User', new mongoose.Schema({}));\n",
    destructured: "const { model, Schema } = require('mongoose');\nconst User = model('User', new Schema({}));\n",
  };
  for (const [form, header] of Object.entries(sources)) {
    const directory = fixture(context, {
      'package.json': JSON.stringify({ dependencies: { mongoose: '^8.0.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { types: [], strict: true } }),
      'users.ts': header + loop,
    });
    const result = run(['--json'], directory);
    const ruleIds = JSON.parse(result.stdout).findings.map((finding) => finding.ruleId);
    assert.ok(ruleIds.includes('orm-query-in-loop'), `${form}: ${ruleIds.join(', ')} ${result.stderr}`);
  }
});
