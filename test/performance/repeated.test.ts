import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { findRepeatOwner } from '../../lib/performance/repeated.js';
import { withProgram } from './helpers.js';
import type { Node, SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.js';

function assertRepeatOwners(source: string, expected: Record<string, string | null>) {
  const owners: Record<string, string | null> = {};
  withProgram(
    'declare function probe(label: string): any;\n' + source,
    {},
    (program: ProgramAdapter, sourceFile: SourceFile) => {
      const checker = program.getTypeChecker();
      function visit(node: Node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'probe') {
          const owner = findRepeatOwner(node, checker);
          const [label] = node.arguments;
          assert.ok(label && ts.isStringLiteral(label));
          owners[label.text] = owner ? ts.SyntaxKind[owner.kind] : null;
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);
    },
  );
  assert.deepEqual(owners, expected);
}

test('distinguishes repeated loop work from one-time setup', () => {
  assertRepeatOwners(
    `
    for (let index = probe('setup'); probe('condition'); probe('update')) probe('body');
    for (const entry of probe('iterable')) probe('forOf');
    for (const key in probe('enumerable')) probe('forIn');
    for (const [id = probe('binding')] of [[1], []]) {}
    while (probe('while')) break;
    do { probe('do'); } while (false);
    for (const group of [1, 2]) for (const row of probe('innerSetup')) {}
  `,
    {
      setup: null,
      condition: 'ForStatement',
      update: 'ForStatement',
      body: 'ForStatement',
      iterable: null,
      forOf: 'ForOfStatement',
      enumerable: null,
      forIn: 'ForInStatement',
      binding: 'ForOfStatement',
      while: 'WhileStatement',
      do: 'DoStatement',
      innerSetup: 'ForOfStatement',
    },
  );
});

test('recognizes direct built-in callbacks using their resolved declaration', () => {
  assertRepeatOwners(
    `
    declare const ids: readonly number[];
    declare const pairs: Map<number, string>;
    declare const options: Set<string>;
    declare const store: { map(callback: () => void): void };
    Promise.all(ids.map(async () => probe('map')));
    ids['filter']((function () { return probe('filter'); }));
    ids.forEach(() => {}, () => probe('thisArg'));
    pairs.forEach(() => probe('mapForEach'));
    options.forEach(() => probe('setForEach'));
    store.map(() => probe('custom'));
    ids.forEach(() => () => probe('deferred'));
    function apply<T extends readonly number[]>(values: T) {
      values.some(() => probe('generic'));
    }
  `,
    {
      map: 'ArrowFunction',
      filter: 'FunctionExpression',
      thisArg: null,
      mapForEach: 'ArrowFunction',
      setForEach: 'ArrowFunction',
      custom: null,
      deferred: null,
      generic: 'ArrowFunction',
    },
  );
});

test('respects function and instance-field execution boundaries', () => {
  assertRepeatOwners(
    `
    for (const row of [1, 2]) {
      (() => probe('iife'))();
      (function* () { probe('generator'); })();
      const later = () => probe('later');
      function deferred() { probe('declared'); }
      class Record {
        id = probe('instance');
        static index = probe('static');
        read() { probe('method'); }
      }
    }
  `,
    {
      iife: 'ForOfStatement',
      generator: null,
      later: null,
      declared: null,
      instance: null,
      static: 'ForOfStatement',
      method: null,
    },
  );
});
