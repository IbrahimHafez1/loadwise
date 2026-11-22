'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, describe, test } = require('node:test');

const { ensureLoaded, parseStatements, splitStatements } = require('../../lib/performance/sql/pg-parser.cjs');

const statementTexts = (sql) => splitStatements(sql).map(({ start, end }) => sql.slice(start, end));

describe('pg statement splitter', () => {
  before(ensureLoaded);

  test('keeps a BEGIN ATOMIC routine body, including CASE ... END, in one statement', () => {
    const routine =
      'CREATE OR REPLACE FUNCTION sign_of(value int) RETURNS int LANGUAGE sql\n' +
      'BEGIN ATOMIC\n  SELECT CASE WHEN value > 0 THEN 1 ELSE 0 END;\n  SELECT 2;\nEND';
    const procedure = 'CREATE PROCEDURE touch() LANGUAGE sql BEGIN ATOMIC UPDATE t SET n = n + 1; END';
    const sql = `${routine};\n${procedure};\nCREATE TABLE t (id int);`;
    assert.deepEqual(statementTexts(sql), [routine, procedure, 'CREATE TABLE t (id int)']);
    const parsed = parseStatements(sql);
    assert.deepEqual(
      parsed.map((statement) => [statement.kind, statement.error]),
      [
        ['CreateFunctionStmt', undefined],
        ['CreateFunctionStmt', undefined],
        ['CreateStmt', undefined],
      ],
    );
  });

  test('a transaction BEGIN ... END still splits at every semicolon', () => {
    const sql = 'BEGIN; CREATE TABLE begin_log (id int); END; SELECT 1;';
    assert.deepEqual(statementTexts(sql), ['BEGIN', 'CREATE TABLE begin_log (id int)', 'END', 'SELECT 1']);
  });

  test('dollar quotes, E strings and nested comments hide their semicolons', () => {
    const sql = "SELECT E'a\\';b', $x$ ; $x$ /* outer /* inner ; */ still ; */; SELECT 2;";
    assert.equal(statementTexts(sql).length, 2);
  });
});

