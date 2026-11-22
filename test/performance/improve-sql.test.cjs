'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, describe, test } = require('node:test');

const { ensureLoaded, parseStatements, splitStatements } = require('../../lib/performance/sql/pg-parser.cjs');
const { changedFilesSince } = require('../../lib/performance/migrations/enforce.cjs');

function temporaryRepository(context) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-improve-sql-')));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q', '-b', 'main');
  return directory;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function write(root, name, text) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
}

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

describe('--changed-since migrations', () => {
  test('a renamed and edited migration is enforced under its new path', (context) => {
    const root = temporaryRepository(context);
    const body = Array.from({ length: 20 }, (_, index) => `SELECT ${index};`).join('\n') + '\n';
    write(root, 'migrations/001_old.sql', body);
    write(root, 'migrations/002_kept.sql', 'SELECT 2;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, 'mv', 'migrations/001_old.sql', 'migrations/001_new.sql');
    write(root, 'migrations/001_new.sql', body + 'SELECT 99;\n');
    git(root, 'commit', '-q', '-am', 'rename');

    const changed = [...changedFilesSince('main', root)].map((file) => path.basename(file));
    assert.deepEqual(changed, ['001_new.sql']);
  });

  test('a migration renamed without edits stays unenforced', (context) => {
    const root = temporaryRepository(context);
    write(root, 'migrations/001_old.sql', 'SELECT 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, 'mv', 'migrations/001_old.sql', 'migrations/001_new.sql');
    git(root, 'commit', '-q', '-m', 'rename');

    assert.deepEqual([...changedFilesSince('main', root)], []);
  });
});

