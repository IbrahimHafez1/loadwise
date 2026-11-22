'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

function rule(findings, ruleId) {
  return findings.filter((finding) => finding.ruleId === ruleId);
}

test('filter length compared with one or wrapped in Boolean() is an existence check', () => {
  const tests = [
    'rows.filter(row => row > 0).length >= 1',
    'rows.filter(row => row > 0).length < 1',
    '1 <= rows.filter(row => row > 0).length',
    '1 > rows.filter(row => row > 0).length',
    'Boolean(rows.filter(row => row > 0).length)',
    '!!rows.filter(row => row > 0).length',
  ];
  const findings = rule(
    lint(`export function check(rows: number[]) { return [${tests.join(', ')}]; }`),
    'filter-for-existence',
  );
  assert.deepEqual(
    findings.map((finding) => finding.message.match(/`(!?some\(\))`/)[1]),
    ['some()', '!some()', 'some()', '!some()', 'some()', 'some()'],
  );
});

test('filter length compared with one as a count threshold, or a shadowed Boolean, stays quiet', () => {
  const tests = [
    'rows.filter(row => row > 0).length > 1',
    'rows.filter(row => row > 0).length <= 1',
    'rows.filter(row => row > 0).length === 1',
    '1 < rows.filter(row => row > 0).length',
    '1 >= rows.filter(row => row > 0).length',
    'Number(rows.filter(row => row > 0).length)',
  ];
  const source = `function Boolean(value: number) { return value; }
export function check(rows: number[]) { return [${tests.join(', ')}, Boolean(rows.filter(row => row > 0).length)]; }`;
  assert.deepEqual(rule(lint(source), 'filter-for-existence'), []);
});
