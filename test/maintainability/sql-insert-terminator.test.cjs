'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const { checkInsertTerminators } = require('../../lib/maintainability/sql-insert-terminator.cjs');

const simplePattern = /INSERT\s+INTO\s+orders\s+VALUES\s*([\s\S]*?);/gi;
const columnPattern = /INSERT\s+INTO\s+"orders"\s+\(([^)]+)\)\s+VALUES\s*([\s\S]*?);/gi;

function parser(pattern, capture) {
  return [
    'function importDump(dump) {',
    '  const insert = ' + pattern + ';',
    '  let match;',
    '  while ((match = insert.exec(dump)) !== null) {',
    '    const values = match[' + capture + '];',
    '    loadRows(values);',
    '  }',
    '}',
  ].join('\n');
}

function findings(source) {
  const filename = 'import.ts';
  return checkInsertTerminators(ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true), filename);
}

test('a valid quoted semicolon is lost by literal INSERT extraction with and without a column list', () => {
  for (const [pattern, table, capture] of [
    [simplePattern, 'orders', 1],
    [columnPattern, '"orders" (label)', 2],
  ]) {
    const values = "('tea; coffee'), ('juice')";
    assert.equal(pattern.exec('INSERT INTO ' + table + ' VALUES ' + values + ';')[capture], "('tea");
    const result = findings(parser(pattern, capture));
    assert.equal(result.length, 1);
    assert.equal(result[0].line, 2);
    assert.equal(result[0].ruleId, 'sql-insert-truncated-at-semicolon');
    assert.equal(result[0].fix, undefined);
  }
});

test('header readers, string-aware patterns, unrelated captures and predicates are left alone', () => {
  for (const source of [
    parser(columnPattern, 1),
    parser(/INSERT\s+INTO\s+orders\s+VALUES\s*/gi, 0),
    parser(/INSERT INTO orders VALUES ((?:'[^']*'|[^';])+);/gi, 1),
    parser(/VALUES\s*([\s\S]*?);/gi, 1),
    parser(simplePattern, 1).replace('const insert =', 'let insert ='),
    parser(simplePattern, 1).replace('insert.exec(dump)', 'other.exec(dump)'),
    parser(simplePattern, 1).replace('const values = match[1]', 'const values = other[1]'),
    'const insert = ' + simplePattern + '; console.log(insert.test(sql));',
  ])
    assert.deepEqual(findings(source), []);
});
