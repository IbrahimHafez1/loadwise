import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { checkInsertTerminators } from '../../lib/maintainability/sql-insert-terminator.cjs';

const simplePattern = /INSERT\s+INTO\s+orders\s+VALUES\s*([\s\S]*?);/gi;
const columnPattern = /INSERT\s+INTO\s+"orders"\s+\(([^)]+)\)\s+VALUES\s*([\s\S]*?);/gi;

function parser(pattern: RegExp, capture: number) {
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

function findings(source: string) {
  const filename = 'import.ts';
  return checkInsertTerminators(ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true), filename);
}

test('a valid quoted semicolon is lost by literal INSERT extraction with and without a column list', () => {
  const cases: [RegExp, string, number][] = [
    [simplePattern, 'orders', 1],
    [columnPattern, '"orders" (label)', 2],
  ];
  for (const [pattern, table, capture] of cases) {
    const values = "('tea; coffee'), ('juice')";
    const match = pattern.exec('INSERT INTO ' + table + ' VALUES ' + values + ';');
    assert.ok(match);
    assert.equal(match[capture], "('tea");
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
