'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin/backend-perf-check.cjs');
const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) require('../lib/native-runtime.cjs').executable();
} catch {
  skip = 'optional native compiler is absent';
}

test('native candidate walk visits the same syntax nodes in compiler order', { skip }, () => {
  const { requireNative, executable } = require('../lib/native-runtime.cjs');
  const { forEachSourceCandidate } = require('../lib/native-checker.cjs');
  const { SyntaxKind } = requireNative('typescript/ast');
  const { API } = requireNative('typescript/sync');
  const kinds = new Set([SyntaxKind.CallExpression, SyntaxKind.NewExpression, SyntaxKind.BinaryExpression]);
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
        const indexed = [];
        const recursive = [];
        forEachSourceCandidate(retained.sourceFile, (node) => indexed.push(node.index));
        function visit(node) {
          if (kinds.has(node.kind)) recursive.push(node.index);
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
      'drizzle',
      'drizzle-policy',
      'orm-queries',
      'query-policy',
      'data-access',
      'awaits',
      'parallel-reads',
      'sort-extreme',
      'collections',
    ].map((name) => path.join(__dirname, name + '.test.cjs'));
    const env = { ...process.env, PERF_CHECK_TEST_NATIVE: '1' };
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
    'flag.ts': 'export function check(keys: string[], ids: string[]) { return keys.map(key => ids.includes(key)); }',
    'clean.ts': 'export const message = "ok";',
    'types.d.ts': 'export declare const label: string;',
    'bad.ts': 'export const broken = ;',
    'one.json': '{"compilerOptions":{"target":"ES2022"},"files":["flag.ts"]}',
    'two.json': '{"compilerOptions":{"target":"ES2022"},"files":["flag.ts","clean.ts","types.d.ts"]}',
    'tsconfig.json': '{"files":[],"references":[{"path":"./one.json"},{"path":"./two.json"}]}',
    'removed.json': '{"compilerOptions":{"moduleResolution":"node10"},"files":["flag.ts"]}',
  };
  context.after(() => {
    for (const name of Object.keys(inputs)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  for (const [name, contents] of Object.entries(inputs)) fs.writeFileSync(path.join(directory, name), contents);
  const run = (args) => spawnSync(process.execPath, [bin, ...args, '--json'], { cwd: directory, encoding: 'utf8' });
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
