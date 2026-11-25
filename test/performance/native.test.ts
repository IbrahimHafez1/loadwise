import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Node } from 'typescript';
import type { Finding } from '../../lib/shared/types.js';
import { forEachSourceCandidate } from '../../lib/performance/native-checker.js';
import { executable, requireNative } from '../../lib/performance/native-runtime.js';

const root = path.resolve(import.meta.dirname, '../..');
const bin = path.join(root, 'bin/loadwise.js');
const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) executable();
} catch {
  skip = 'optional native compiler is absent';
}

// Nodes of the native SDK carry the index of their slot in the encoded syntax tree.
function nativeIndexOf(node: Node): number {
  assert.ok('index' in node && typeof node.index === 'number');
  return node.index;
}

test('native candidate walk visits the same syntax nodes in compiler order', { skip }, () => {
  const { SyntaxKind } = requireNative('typescript/ast');
  const { API } = requireNative('typescript/sync');
  const kinds = new Set([
    SyntaxKind.CallExpression,
    SyntaxKind.NewExpression,
    SyntaxKind.ReturnStatement,
    SyntaxKind.TaggedTemplateExpression,
    SyntaxKind.BinaryExpression,
  ]);
  const cases = {
    'component.tsx': `@decorate(factory())
      class Widget {
        render(view = new View(init())) {
          const item = view?.read?.(key());
          return <Pane prop={item ?? fallback()}>{items.map(row => <span>{row.value = read()}</span>)}</Pane>;
        }
      }`,
    'example.js': `/** @param {import('./schema').Item} item
      * @example calculate(fn(), new View()); value = 1;
      */
      function run(item) { return item?.refresh?.(prepare(item)) ?? new Result(); }
      /** @type {typeof import('./metadata')} */
      const metadata = getMetadata();`,
    'unicode.ts': 'const label = "مرحبا 🌍"; items[lookup(label)] = build(new Item(label));',
  };
  const api = new API({ tsserverPath: executable() });
  try {
    for (const [name, contents] of Object.entries(cases)) {
      const retained = api.createSourceFile(name, contents);
      try {
        const indexed: number[] = [];
        const recursive: number[] = [];
        forEachSourceCandidate(retained.sourceFile, (node: Node) => indexed.push(nativeIndexOf(node)));
        function visit(node: Node) {
          if (kinds.has(node.kind)) recursive.push(nativeIndexOf(node));
          node.forEachChild(visit);
        }
        visit(retained.sourceFile);
        assert.ok(recursive.length > 0, name);
        assert.deepEqual(indexed, recursive, name);
      } finally {
        retained.dispose();
      }
    }
  } finally {
    api.close();
  }
});

test(
  'native compiler passes the shared filesystem, pooling, PostgreSQL, Prisma and collection rule fixtures',
  { skip },
  () => {
    const suites = [
      'node-fs',
      'pooling',
      'postgres',
      'pg-integrity',
      'prisma',
      'prisma-integrity',
      'dependent-writes',
      'drizzle',
      'orm-queries',
      'awaits',
      'parallel-reads',
      'sort-extreme',
      'collections',
    ].map((name) => path.join(import.meta.dirname, name + '.test.js'));
    const env: NodeJS.ProcessEnv = { ...process.env, PERF_CHECK_TEST_NATIVE: '1' };
    delete env.NODE_TEST_CONTEXT;
    // The excluded test instruments TS5 watch-program reuse. Native runs are one-shot.
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        '--test-reporter=tap',
        '--test-skip-pattern=a rebuilt program checks writes again',
        ...suites,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass [1-9]\d*/);
  },
);

test('native CLI covers clean and flagged files, overlapping configs, and invalid inputs', { skip }, (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'backend-perf-native-test-'));
  const inputs = {
    'flag.ts':
      'export function check(keys: string[], payload: string) { const ids: string[] = JSON.parse(payload); return keys.map(key => ids.includes(key)); }',
    'clean.ts': 'export const message = "ok";',
    'types.d.ts': 'export declare const label: string;',
    'bad.ts': 'export const broken = ;',
    'one.json': '{"compilerOptions":{"target":"ES2022"},"files":["flag.ts"]}',
    'two.json': '{"compilerOptions":{"target":"ES2022"},"files":["flag.ts","clean.ts","types.d.ts"]}',
    'tsconfig.json': '{"files":[],"references":[{"path":"./one.json"},{"path":"./two.json"}]}',
    'removed.json': '{"compilerOptions":{"moduleResolution":"classic"},"files":["flag.ts"]}',
  };
  context.after(() => {
    for (const name of Object.keys(inputs)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  for (const [name, contents] of Object.entries(inputs)) fs.writeFileSync(path.join(directory, name), contents);
  const run = (args: readonly string[]) =>
    spawnSync(process.execPath, [bin, 'perf', ...args, '--json'], { cwd: directory, encoding: 'utf8' });
  const native = run(['--native', '-p', '.']);
  assert.equal(native.status, 1, native.stderr);
  assert.deepEqual(JSON.parse(native.stdout), JSON.parse(run(['-p', '.']).stdout));
  assert.equal(JSON.parse(native.stdout).scannedFiles, 2);
  assert.equal(JSON.parse(native.stdout).findings.length, 1);
  assert.equal(run(['--native', 'clean.ts']).status, 0);
  assert.equal(run(['--native', 'flag.ts']).status, 1);
  for (const args of [['bad.ts'], ['missing.ts'], ['-p', 'removed.json'], ['-p', 'missing.json']]) {
    const result = run(['--native', ...args]);
    assert.equal(result.status, 2, result.stdout);
    assert.ok(result.stderr.trim());
  }
});

test(
  'native CLI attaches the same site fixes as the JS compiler, including builders that reuse rule helpers',
  { skip },
  (context) => {
    const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
    fs.mkdirSync(base, { recursive: true });
    const directory = fs.mkdtempSync(path.join(base, 'backend-perf-native-fix-'));
    const inputs = {
      'serial.ts': [
        'declare function first(): Promise<number>;',
        'declare function second(): Promise<number>;',
        'export async function load() {',
        '  const [left, right] = [await first(), await second()];',
        "  const response = await fetch('https://example.test/data');",
        '  return [left, right, response];',
        '}',
      ].join('\n'),
      'tsconfig.json': '{"compilerOptions":{"target":"ES2022","lib":["ES2022","DOM"]},"files":["serial.ts"]}',
    };
    context.after(() => {
      for (const name of Object.keys(inputs)) fs.unlinkSync(path.join(directory, name));
      fs.rmdirSync(directory);
    });
    for (const [name, contents] of Object.entries(inputs)) fs.writeFileSync(path.join(directory, name), contents);
    const run = (args: readonly string[]) =>
      spawnSync(process.execPath, [bin, 'perf', ...args, '--json'], { cwd: directory, encoding: 'utf8' });
    const native = JSON.parse(run(['--native', '-p', '.']).stdout);
    assert.deepEqual(native, JSON.parse(run(['-p', '.']).stdout));
    const fixedRules = native.findings
      .filter((finding: Finding) => finding.fix)
      .map((finding: Finding) => finding.ruleId);
    assert.deepEqual(fixedRules.sort(), ['http-call-without-timeout', 'serial-awaits-in-literal']);
  },
);

test('a missing `types` entry is noted on stderr instead of aborting the native scan', { skip }, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-native-types-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const compilerOptions = { types: ['vitest/globals'], module: 'commonjs', target: 'es2022' };
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['index.ts'] }));
  fs.writeFileSync(path.join(directory, 'index.ts'), 'export const answer = 42;\n');
  const result = spawnSync(process.execPath, [bin, 'perf', '--engine', 'native', '-p', 'tsconfig.json', '--json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Note: type libraries not installed \(vitest\/globals\)/);
  assert.equal(JSON.parse(result.stdout).scannedFiles, 1);
});
