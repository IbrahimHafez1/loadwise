'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lint } = require('./helpers.cjs');

function copyingReducers(source) {
  return lint(source).filter(({ ruleId }) => ruleId === 'reduce-copy-accumulator');
}

test('reducers over a small fixed set of own object properties do not report growing copies', () => {
  const findings = copyingReducers(`
    function options(port: number) {
      Object.entries({ host: 'localhost', port, tls: true, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })
        .reduce<Record<string, unknown>>((result, [key, value]) => {
        if (value !== undefined) return { ...result, [key]: value };
        return result;
      }, {});
      Object.keys({ host: 'localhost', port }).reduce<string[]>((list, key) => [...list, key], []);
      Object.values({ host: 'localhost', port }).reduce<unknown[]>((list, value) => [...list, value], []);
    }
  `);
  assert.equal(findings.length, 0);
});

test('reducers still report when the object source or enumeration is not statically bounded', () => {
  const findings = copyingReducers(`
    function options(options: Record<string, number>, key: string) {
      Object.keys(options).reduce<string[]>((list, name) => [...list, name], []);
      Object.keys({ ...options }).reduce<string[]>((list, name) => [...list, name], []);
      Object.keys({ [key]: 1 }).reduce<string[]>((list, name) => [...list, name], []);
      Object.keys({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9,
        j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17 })
        .reduce<string[]>((list, name) => [...list, name], []);
    }
    function custom(names: string[]) {
      const Object = { keys(_input: object) { return names; } };
      Object.keys({ a: 1 }).reduce<string[]>((list, name) => [...list, name], []);
    }
  `);
  assert.equal(findings.length, 5);
});

test('reducers still report when the same file replaces the built-in enumeration method', () => {
  const findings = copyingReducers(`
    function options(names: string[]) {
      Object.keys = () => names;
      return Object.keys({ a: 1 }).reduce<string[]>((list, name) => [...list, name], []);
    }
  `);
  assert.equal(findings.length, 1);
});
