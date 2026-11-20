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
