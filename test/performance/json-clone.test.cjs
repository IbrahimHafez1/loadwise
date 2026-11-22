'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lint } = require('./helpers.cjs');

function check(source) {
  return lint(source).filter((finding) => finding.ruleId === 'json-roundtrip-clone');
}

test('reports a JSON round-trip clone inside a loop', () => {
  const findings = check(
    [
      'export function run(items: object[]) {',
      '  const copies = [];',
      '  for (const item of items) copies.push(JSON.parse(JSON.stringify(item)));',
      '  return copies;',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /structuredClone/);
});

test('reports a JSON round-trip clone inside an array callback', () => {
  const findings = check(
    'export const run = (items: object[]) => items.map((item) => JSON.parse(JSON.stringify(item)));',
  );
  assert.equal(findings.length, 1);
});

test('ignores a one-off clone, a reviver parse and a plain parse in a loop', () => {
  const findings = check(
    [
      'const defaults = { a: 1 };',
      'export const snapshot = JSON.parse(JSON.stringify(defaults));',
      'export function run(texts: string[]) {',
      '  for (const text of texts) {',
      '    JSON.parse(text);',
      '    JSON.parse(JSON.stringify(defaults), (key, value) => value);',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});
