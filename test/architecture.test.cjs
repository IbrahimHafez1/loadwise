'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path').posix;
const ts = require('typescript');
const { analyzeArchitecture, checkGraph, collectEdges } = require('../lib/architecture.cjs');

function fixture(contents, boundaries = [], compilerOptions = {}) {
  const names = new Set(Object.keys(contents));
  const files = [...names].map((file) => ({
    file,
    compilerOptions,
    sourceFile: ts.createSourceFile('/repo/' + file, contents[file], ts.ScriptTarget.Latest, true),
  }));
  function resolve(specifier, absolute, modeNode) {
    assert.ok(ts.isStringLiteralLike(modeNode));
    const prefix = specifier.startsWith('@/')
      ? specifier.slice(2)
      : specifier.startsWith('.')
        ? path.join(path.dirname(absolute.slice('/repo/'.length)), specifier)
        : '';
    return [prefix, prefix + '.ts', prefix + '.js'].find((candidate) => names.has(candidate));
  }
  return {
    findings: analyzeArchitecture({ files, resolve, boundaries }),
    edges: files.flatMap(({ sourceFile, file }) => collectEdges(sourceFile, file, resolve, compilerOptions)),
  };
}

test('eager selector loads close cycles while conditional branch loads remain deferred', () => {
  const selectors = [
    "if (require('./b')) {}",
    "switch (require('./b')) {}",
    "const value = require('./b') || 'fallback';",
    "const value = require('./b') ? 'one' : 'two';",
    "for (const value of require('./b')) {}",
    "while (require('./b')) break;",
    "require('./b')?.start();",
  ];
  for (const source of selectors) {
    const { findings } = fixture({ 'a.js': source, 'b.js': "require('./a');" });
    assert.equal(findings[0]?.ruleId, 'dependency-cycle', source);
  }
  for (const source of [
    "if (active) require('./b');",
    "active && require('./b');",
    "selected ||= require('./b');",
    "selected &&= require('./b');",
    "selected ??= require('./b');",
    "logger?.log(require('./b'));",
    "registry?.[require('./b')];",
    "const use = () => require('./b') || null;",
  ]) {
    assert.equal(fixture({ 'a.js': source, 'b.js': "require('./a');" }).findings.length, 0, source);
  }
});

test('cycles contain actual edges in deterministic witness order', () => {
  const sources = {
    'a.ts': "export * from './c';",
    'b.ts': "import './a';",
    'c.ts': "import '@/b';\nimport 'outside';",
  };
  const { findings } = fixture(sources);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'dependency-cycle');
  assert.equal(findings[0].message, 'Dependency cycle: a.ts → c.ts → b.ts → a.ts');
  assert.deepEqual(
    [findings[0], ...findings[0].related].map(({ file, line }) => [file, line]),
    [
      ['a.ts', 1],
      ['c.ts', 1],
      ['b.ts', 1],
    ],
  );
  assert.deepEqual(fixture(Object.fromEntries(Object.entries(sources).reverse())).findings, findings);
});

test('source edges respect type-only syntax, erased imports, and verbatim module settings', () => {
  const contents = {
    'a.ts': [
      "import type {A} from './b';",
      "import {type B} from './b';",
      "export type { C } from './b';",
      "import {D} from './b';",
      'export type Only = typeof D;',
      "import {E} from './b';",
      'export class App extends E {}',
      "export {type F, value} from './b';",
      "import type Alias = require('./b');",
    ].join('\n'),
    'b.ts': 'export const value = 1;',
  };
  assert.deepEqual(
    fixture(contents)
      .edges.map((edge) => edge.line)
      .sort((left, right) => left - right),
    [6, 8],
  );
  assert.deepEqual(
    fixture(contents, [], { verbatimModuleSyntax: true })
      .edges.map((edge) => edge.line)
      .sort((left, right) => left - right),
    [2, 4, 6, 8],
  );
});

test('layer prefix is segment-aware, opt-in, and also checks deferred loads', () => {
  const contents = {
    'src/domain/a.ts': [
      "export const lazy = () => import('@/src/http/x');",
      "function fake(require: Function) { require('@/src/http/x'); }",
      "if (enabled) require('@/src/http/x');",
      "export function later() { require('@/src/http/x'); }",
      'require(dynamicName);',
    ].join('\n'),
    'src/http/x.ts': "import '@/src/domain/a';",
    'src/domain-extra/b.ts': "require('@/src/http/x');",
    'src/domain/declarations.d.ts': "export * from '@/src/http/x';",
  };
  assert.deepEqual(fixture(contents).findings, []);
  const { findings } = fixture(contents, [{ from: './src/domain/', disallow: ['src\\http'] }]);
  assert.deepEqual(
    findings.map((row) => [row.file, row.line, row.ruleId]),
    [
      ['src/domain/a.ts', 1, 'folder-boundary'],
      ['src/domain/a.ts', 3, 'folder-boundary'],
      ['src/domain/a.ts', 4, 'folder-boundary'],
    ],
  );
});

test('top-level CommonJS cycles include literal requires and ignore shadowed requires', () => {
  const contents = {
    'a.js': "require('./b');",
    'b.js': "require('./a');",
    'c.js': "const require = () => {}; require('./a');",
  };
  assert.equal(fixture(contents).findings.length, 1);
  assert.deepEqual(
    fixture(contents).edges.map((edge) => edge.from),
    ['a.js', 'b.js'],
  );
});

test('a type-only use, object member name or shadowed value does not keep an unused import at runtime', () => {
  const code = [
    "import {Shape} from './b';",
    'type Container = {value: Shape};',
    'export const read = (Shape: string) => Shape;',
    "export const property = { Shape: 'demo' };",
    'export function key(value: {Shape:string}) { return value.Shape; }',
  ].join('\n');
  assert.deepEqual(fixture({ 'a.ts': code, 'b.ts': "import './a';" }).findings, []);
  assert.equal(fixture({ 'a.ts': code + '\nexport const value = Shape;', 'b.ts': "import './a';" }).findings.length, 1);
});

test('large language-independent graphs avoid recursion and return one witness per component', () => {
  const files = Array.from({ length: 12000 }, (_, index) => 'lib/' + index + '.py');
  const edges = files.slice(1).map((to, index) => ({ from: files[index], to, line: 2, column: 3 }));
  edges.push({ from: files.at(-1), to: files.at(-2), line: 3, column: 1 });
  edges.push({ from: files[0], to: files[0], line: 1, column: 1 });
  edges.push({ from: files.at(-1), to: files[0], line: 4, column: 1, kind: 'deferred' });
  const findings = checkGraph({ files, edges });
  assert.equal(findings.length, 2);
  assert.ok(findings.some((row) => row.related.length === 0));
  assert.ok(findings.some((row) => row.related.length === 1));
  assert.deepEqual(checkGraph({ files: [...files].reverse(), edges: [...edges].reverse() }), findings);
});

test('only fully evidenced Nest forwardRef cycles receive context', () => {
  const nestModule = (name, other) =>
    [
      "import {Module as NestModule, forwardRef as later} from '@nestjs/common';",
      `import {${other}} from './${other}';`,
      `@NestModule({imports: [later(() => ${other})]}) export class ${name} {}`,
    ].join('\n');
  const modules = { 'A.ts': nestModule('A', 'B'), 'B.ts': nestModule('B', 'A') };
  for (const options of [{}, { verbatimModuleSyntax: true }]) {
    const { findings } = fixture(modules, [], options);
    assert.equal(findings.length, 1);
    assert.match(findings[0].contextualReason, /Nest/);
    assert.equal(findings[0].related.length, 1);
  }
  for (const extra of [
    "import './B';",
    'export const eager = B;',
    'class Eager extends B {}',
    '@B() class Decorated {}',
    'class WithMetadata { @Inject() field!: B }',
    "import './C';",
  ]) {
    const { findings } = fixture({ ...modules, 'A.ts': modules['A.ts'] + '\n' + extra, 'C.ts': "import './A';" });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].contextualReason, undefined, extra);
  }
  const lookalike = modules['B.ts'].replace('@nestjs/common', 'other-library');
  assert.equal(fixture({ ...modules, 'B.ts': lookalike }).findings[0].contextualReason, undefined);
  const edges = [
    { from: 'A.ts', to: 'B.ts', line: 2, column: 1 },
    { from: 'B.ts', to: 'A.ts', line: 2, column: 1 },
  ];
  assert.equal(checkGraph({ files: Object.keys(modules), edges })[0].contextualReason, undefined);
});
