'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const { analyzeArchitecture } = require('../lib/architecture.cjs');

function cycleFindings(contents, compilerOptions = {}) {
  const names = new Set(Object.keys(contents));
  const files = [...names].map((file) => ({
    file,
    compilerOptions,
    sourceFile: ts.createSourceFile('/repo/' + file, contents[file], ts.ScriptTarget.Latest, true),
  }));
  function resolve(specifier) {
    return specifier.startsWith('.')
      ? [specifier.slice(2) + '.ts'].find((candidate) => names.has(candidate))
      : undefined;
  }
  return analyzeArchitecture({ files, resolve, boundaries: [] }).filter((row) => row.ruleId === 'dependency-cycle');
}

test('entity imports read only inside relation callbacks do not form a load-time cycle', () => {
  const entity = (own, other) =>
    `import { ManyToOne } from 'typeorm';\nimport { ${other} } from './${other}';\n` +
    `export class ${own} { @ManyToOne(() => ${other}, (peer) => peer.items) peer!: ${other}; }`;
  assert.equal(cycleFindings({ 'A.ts': entity('A', 'B'), 'B.ts': entity('B', 'A') }).length, 0);
});

test('imports read while the module loads still close a cycle', () => {
  const importer = (other, body) => `import { ${other} } from './${other}';\n${body}`;
  for (const [first, second] of [
    ['export const value = B;', 'export const other = A;'],
    ['export class A extends B {}', 'export const lazy = () => A;\nexport const other = A;'],
    ['@B() export class A {}', '@A() export class B {}'],
  ]) {
    const findings = cycleFindings({ 'A.ts': importer('B', first), 'B.ts': importer('A', second) });
    assert.equal(findings.length, 1, first);
  }
  const lazyOnly = {
    'A.ts': importer('B', 'export const make = () => B;'),
    'B.ts': importer('A', 'export const value = A;'),
  };
  assert.equal(cycleFindings(lazyOnly).length, 0);
});

test('decorator metadata types keep a cycle unless the decorator supplies a type thunk', () => {
  const service = (own, other, member) =>
    `import { ${other} } from './${other}';\nexport const lazy = () => ${other};\n@Injectable() export class ${own} { ${member} }`;
  const cycle = (member) =>
    cycleFindings(
      { 'A.ts': service('A', 'B', member('B')), 'B.ts': service('B', 'A', member('A')) },
      { emitDecoratorMetadata: true },
    );
  assert.equal(cycle((other) => `constructor(private peer: ${other}) {}`).length, 1);
  assert.equal(cycle((other) => `@Inject() peer!: ${other};`).length, 1);
  assert.equal(cycle((other) => `@Inject(forwardRef(() => ${other})) peer!: ${other};`).length, 0);
});

test('decorator arguments and static initializers run at class definition and keep a cycle', () => {
  const importer = (body) => `import { A } from './A';\n${body}`;
  const a = "import { B } from './B';\nexport const make = B;";
  for (const body of [
    'export class B { static peer = A.name; }',
    'export class B { @Inject(A) peer!: unknown; }',
    'export class B { @Inject(A) method() {} }',
    'export class B { method(@Inject(A) peer: unknown) {} }',
    'export class B { constructor(@Inject(A) peer: unknown) {} }',
  ]) {
    assert.equal(cycleFindings({ 'A.ts': a, 'B.ts': importer(body) }).length, 1, body);
  }
  const lazy = 'export class B { peer = A.name; method() { return A; } }';
  assert.equal(cycleFindings({ 'A.ts': a, 'B.ts': importer(lazy) }).length, 0);
});

const { createDuplicateIndex } = require('../lib/duplicates.cjs');

const sharedBody = `{
  const cleaned = input.trim();
  if (!cleaned || cleaned.length > 20) return fallback;
  const pieces = cleaned.split("-");
  return pieces.map(piece => piece.toLowerCase()).join("_");
}`;
const declaration = (name) => `function ${name}(input: string, fallback: string) ${sharedBody}`;

function duplicateFindings(files) {
  const index = createDuplicateIndex();
  for (const [file, source] of Object.entries(files)) {
    index.add(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), file);
  }
  return index.findings();
}

test('test-local setup closures nested in test callbacks are not duplicate implementations', () => {
  const nested = (name) => `describe('x', () => {\n${declaration(name)}\n});`;
  assert.equal(duplicateFindings({ 'a.test.ts': nested('one'), 'b.test.ts': nested('two') }).length, 0);
  // Top-level helpers shared between tests, and nested closures in production code, still report.
  assert.equal(duplicateFindings({ 'a.test.ts': declaration('one'), 'b.test.ts': declaration('two') }).length, 1);
  const production = (name) => `export function outer() {\n${declaration(name)}\n}`;
  assert.equal(duplicateFindings({ 'a.ts': production('one'), 'b.ts': production('two') }).length, 1);
});

test('standalone sample, fixture and migration directories are not duplicate implementations', () => {
  for (const directory of ['sample/app', 'examples/app', 'integration/app', 'src/migrations', 'test/fixtures']) {
    const files = { [directory + '/a.ts']: declaration('one'), 'src/b.ts': declaration('two') };
    assert.equal(duplicateFindings(files).length, 0, directory);
    const both = { [directory + '/a.ts']: declaration('one'), [directory + '/b.ts']: declaration('two') };
    assert.equal(duplicateFindings(both).length, 0, directory);
  }
  assert.equal(duplicateFindings({ 'src/a.ts': declaration('one'), 'src/b.ts': declaration('two') }).length, 1);
});

test('scanning on worker threads gives the same result and the same first error as a single thread', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scan } = require('../lib/scan.cjs');
  const policy = { exclude: [], boundaries: [], placement: [] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-parallel-'));
  try {
    const duplicated = (name) => `export ${declaration(name)}`;
    fs.writeFileSync(path.join(root, 'a.ts'), "import { b } from './b';\nexport const a = b;\n" + duplicated('one'));
    fs.writeFileSync(path.join(root, 'b.ts'), "import { a } from './a';\nexport const b = a;\n" + duplicated('two'));
    for (let index = 0; index < 40; index++)
      fs.writeFileSync(path.join(root, `f${index}.ts`), `export const v${index} = ${index};\n`);
    const single = await scan(root, policy, { parallelFrom: Infinity });
    const threaded = await scan(root, policy, { parallelFrom: 1 });
    assert.deepEqual(threaded, single);
    assert.ok(single.findings.some((row) => row.ruleId === 'duplicate-implementation'));
    assert.ok(single.findings.some((row) => row.ruleId === 'dependency-cycle'));
    fs.writeFileSync(path.join(root, 'f30.ts'), 'export const = ;\n');
    fs.writeFileSync(path.join(root, 'f10.ts'), 'export const = 1;\n');
    const errors = [];
    for (const parallelFrom of [Infinity, 1]) {
      errors.push(await scan(root, policy, { parallelFrom }).then(String, String));
    }
    assert.match(errors[0], /f10\.ts:1:/);
    assert.equal(errors[1], errors[0]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
