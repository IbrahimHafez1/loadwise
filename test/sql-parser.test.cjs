'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, describe, test } = require('node:test');

const { byteOffsetToPosition, createPositionIndex, positionInTemplate } = require('../lib/sql/locations.cjs');
const { ensureLoaded, parseExplainCandidate, parseStatements } = require('../lib/sql/pg-parser.cjs');
const { parseMysqlStatements } = require('../lib/sql/mysql-tokens.cjs');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'sql', name), 'utf8');
const kinds = (statements) => statements.map((statement) => statement.kind);
const only = (sql) => parseStatements(sql)[0];

describe('locations', () => {
  test('converts UTF-8 byte offsets to line and UTF-16 column', () => {
    const text = 'a\nمرحبا x\n😀y';
    const bytesBeforeX = Buffer.byteLength('a\nمرحبا ');
    assert.deepEqual(byteOffsetToPosition(text, bytesBeforeX), { line: 2, column: 7 });
    assert.deepEqual(byteOffsetToPosition(text, Buffer.byteLength('a\nمرحبا x\n😀')), { line: 3, column: 3 });
    assert.deepEqual(createPositionIndex(text).fromByteOffset(0), { line: 1, column: 1 });
  });

  test('maps template literal offsets to file positions', () => {
    const start = { line: 10, column: 5 };
    assert.deepEqual(positionInTemplate(start, 'SELECT 1', 7), { line: 10, column: 12 });
    assert.deepEqual(positionInTemplate(start, 'a\n  b', 4), { line: 11, column: 3 });
  });
});

describe('postgres parser', () => {
  before(ensureLoaded);

  test('throws a clear error when used before loading is awaited', () => {
    const script = "require('./lib/sql/pg-parser.cjs').parseStatements('SELECT 1')";
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    assert.match(result.stderr, /await ensureLoaded/);
  });

  test('CREATE INDEX with and without CONCURRENTLY', () => {
    const plain = only('CREATE INDEX i ON t (a)').node.IndexStmt;
    const concurrent = only('CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)').node.IndexStmt;
    assert.equal(Boolean(plain.concurrent), false);
    assert.equal(concurrent.concurrent, true);
    assert.equal(concurrent.unique, true);
  });

  test('ALTER TABLE column and constraint commands', () => {
    const addColumn = only('ALTER TABLE t ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid()');
    const command = addColumn.node.AlterTableStmt.cmds[0].AlterTableCmd;
    assert.equal(command.subtype, 'AT_AddColumn');
    assert.equal(command.def.ColumnDef.constraints.length, 2);

    const subtypeOf = (sql) => only(sql).node.AlterTableStmt.cmds[0].AlterTableCmd.subtype;
    assert.equal(subtypeOf('ALTER TABLE t ALTER COLUMN a SET NOT NULL'), 'AT_SetNotNull');
    assert.equal(subtypeOf('ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID'), 'AT_AddConstraint');
    assert.equal(subtypeOf('ALTER TABLE t VALIDATE CONSTRAINT c'), 'AT_ValidateConstraint');
    assert.equal(subtypeOf('ALTER TABLE t DROP COLUMN a'), 'AT_DropColumn');
    const notValid = only('ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID');
    const constraint = notValid.node.AlterTableStmt.cmds[0].AlterTableCmd.def.Constraint;
    assert.equal(constraint.skip_validation, true);
  });

  test('RENAME and DROP statements', () => {
    assert.equal(only('ALTER TABLE t RENAME COLUMN a TO b').kind, 'RenameStmt');
    assert.equal(only('ALTER TABLE t RENAME TO u').kind, 'RenameStmt');
    assert.equal(only('DROP TABLE t').kind, 'DropStmt');
  });

  test('a DO block with semicolons and dollar quotes stays one statement', () => {
    const statements = parseStatements("DO $$ BEGIN PERFORM 1; RAISE NOTICE 'a;b'; END $$;\nSELECT 1;");
    assert.deepEqual(kinds(statements), ['DoStmt', 'SelectStmt']);
  });

  test('splitting respects comments, E strings and tagged dollar quotes', () => {
    const sql = "SELECT E'it\\'s;'; -- trailing; comment\nSELECT $tag$;$tag$; /* a; b */ SELECT 3;";
    assert.deepEqual(kinds(parseStatements(sql)), ['SelectStmt', 'SelectStmt', 'SelectStmt']);
  });

  test('Prisma migration file shape', () => {
    const statements = parseStatements(fixture('prisma-migration.sql'));
    assert.deepEqual(kinds(statements), ['CreateStmt', 'IndexStmt', 'AlterTableStmt']);
    assert.equal(statements[1].line, 9);
    assert.equal(statements[1].column, 1);
  });

  test('Drizzle statement-breakpoint comments are separators, not statements', () => {
    const statements = parseStatements(fixture('drizzle-migration.sql'));
    assert.deepEqual(kinds(statements), ['CreateStmt', 'AlterTableStmt', 'IndexStmt']);
    assert.equal(statements[1].line, 6);
    assert.equal(statements[2].line, 7);
  });

  test('a syntax error is reported per statement without hiding the others', () => {
    const statements = parseStatements(fixture('syntax-error-middle.sql'));
    assert.deepEqual(kinds(statements), ['IndexStmt', null, 'IndexStmt']);
    assert.equal(statements[1].error.line, 2);
    assert.match(statements[1].error.message, /syntax error/);
    assert.equal(statements[2].line, 3);
  });

  test('line and column stay correct with multibyte Arabic text', () => {
    const text = fixture('arabic.sql');
    const statements = parseStatements(text);
    assert.deepEqual(kinds(statements), ['InsertStmt', null, 'IndexStmt']);
    assert.equal(statements[0].line, 2);
    assert.equal(statements[1].line, 3);
    assert.equal(statements[1].error.line, 3);

    const index = statements[2];
    assert.equal(index.line, 4);
    const tableLocation = index.node.IndexStmt.relation.location;
    const position = index.locate(tableLocation);
    const lineText = text.split('\n')[position.line - 1];
    assert.equal(position.line, 4);
    assert.equal(lineText.slice(position.column - 1, position.column + 8), '"العملاء"');
  });

  test('parseExplainCandidate classifies EXPLAIN text', () => {
    assert.deepEqual(parseExplainCandidate('SELECT 1'), {
      kind: 'SelectStmt',
      hasInto: false,
      hasLockingClause: false,
      hasDataModifyingCte: false,
    });
    assert.equal(parseExplainCandidate('SELECT * INTO copy FROM t').hasInto, true);
    assert.equal(parseExplainCandidate('SELECT * FROM t FOR UPDATE').hasLockingClause, true);
    assert.equal(
      parseExplainCandidate('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d').hasDataModifyingCte,
      true,
    );
    assert.equal(parseExplainCandidate('DELETE FROM t').kind, 'DeleteStmt');
    assert.ok(parseExplainCandidate('SELECT 1; SELECT 2').error);
    assert.ok(parseExplainCandidate('SELECT FROM WHERE').error);
  });
});

describe('mysql tokenizer and recognizer', () => {
  const only1 = (sql) => parseMysqlStatements(sql)[0];

  test('ALTER TABLE sub-commands', () => {
    const statement = only1(
      'ALTER TABLE `db`.`t` ADD COLUMN a INT NOT NULL, DROP COLUMN b, MODIFY c BIGINT, CHANGE d e INT, ' +
        'RENAME COLUMN f TO g, ADD INDEX i (a), DROP PRIMARY KEY, CONVERT TO CHARACTER SET utf8mb4, ' +
        'ALGORITHM=COPY, LOCK=SHARED',
    );
    assert.equal(statement.kind, 'alter-table');
    assert.equal(statement.table, 't');
    assert.equal(statement.schema, 'db');
    assert.deepEqual(
      statement.actions.map((action) => action.type),
      [
        'add-column',
        'drop-column',
        'modify-column',
        'change-column',
        'rename-column',
        'add-index',
        'drop-primary-key',
        'convert-charset',
      ],
    );
    assert.equal(statement.actions[0].notNull, true);
    assert.equal(statement.actions[0].hasDefault, false);
    assert.equal(statement.actions[3].newName, 'e');
    assert.equal(statement.algorithm, 'COPY');
    assert.equal(statement.lock, 'SHARED');
  });

  test('CREATE INDEX, DROP and RENAME TABLE', () => {
    const [createIndex, dropTable, dropIndex, rename] = parseMysqlStatements(
      'CREATE UNIQUE INDEX i ON t (a) ALGORITHM=INPLACE LOCK=NONE;\n' +
        'DROP TABLE IF EXISTS a, `b`;\nDROP INDEX i ON t;\nRENAME TABLE a TO b, c TO d;',
    );
    assert.deepEqual(
      [createIndex.kind, createIndex.table, createIndex.unique, createIndex.algorithm, createIndex.lock],
      ['create-index', 't', true, 'INPLACE', 'NONE'],
    );
    assert.deepEqual(
      dropTable.tables.map((table) => table.table),
      ['a', 'b'],
    );
    assert.equal(dropIndex.kind, 'drop-index');
    assert.deepEqual(
      rename.renames.map((pair) => pair.to.table),
      ['b', 'd'],
    );
    assert.equal(rename.line, 4);
  });

  test('comments and quotes hide semicolons', () => {
    const statements = parseMysqlStatements(
      '# note; here\nSELECT \';\' /* ; */ , `a;b`; -- x;\nDROP TABLE t; SELECT "it\\";s";',
    );
    assert.deepEqual(
      statements.map((statement) => statement.kind),
      ['other', 'drop-table', 'other'],
    );
    assert.equal(statements[0].line, 2);
  });

  test('DELIMITER procedures stay one statement and later statements are recognized', () => {
    const statements = parseMysqlStatements(fixture('mysql-procedure.sql'));
    assert.deepEqual(
      statements.map((statement) => statement.kind),
      ['other', 'alter-table'],
    );
    assert.match(statements[0].text, /^CREATE PROCEDURE bump/);
    assert.equal(statements[0].line, 3);
    assert.equal(statements[1].line, 9);
    assert.equal(statements[1].lock, 'NONE');
  });

  test('IF [NOT] EXISTS is skipped before names', () => {
    const statement = only1(
      'ALTER TABLE IF EXISTS t DROP COLUMN IF EXISTS a, ADD COLUMN IF NOT EXISTS b INT NOT NULL, ' +
        'MODIFY COLUMN IF EXISTS c INT, CHANGE IF EXISTS d e INT, DROP INDEX IF EXISTS i, RENAME COLUMN IF EXISTS f TO g',
    );
    assert.equal(statement.table, 't');
    assert.deepEqual(
      statement.actions.map((action) => [action.type, action.column ?? action.index, action.newName]),
      [
        ['drop-column', 'a', undefined],
        ['add-column', 'b', undefined],
        ['modify-column', 'c', undefined],
        ['change-column', 'd', 'e'],
        ['drop-index', 'i', undefined],
        ['rename-column', 'f', 'g'],
      ],
    );
    assert.equal(only1('CREATE INDEX IF NOT EXISTS idx ON t (a)').index, 'idx');
    assert.equal(only1('DROP INDEX IF EXISTS idx ON t').index, 'idx');
    assert.deepEqual(
      only1('DROP TABLE IF EXISTS a, b').tables.map((entry) => entry.table),
      ['a', 'b'],
    );
  });

  test('each ALTER TABLE action carries its own start offset', () => {
    const sql = 'ALTER TABLE t\n  DROP COLUMN a,\n  MODIFY b INT';
    const { actions } = only1(sql);
    assert.deepEqual(
      actions.map((action) => sql.slice(action.start, action.start + 6)),
      ['DROP C', 'MODIFY'],
    );
  });

  test('unrecognized or incomplete statements are other', () => {
    assert.equal(only1('ALTER VIEW v AS SELECT 1').kind, 'other');
    assert.equal(only1('ALTER TABLE').kind, 'other');
    assert.equal(only1('CREATE TABLE t (a INT)').kind, 'other');
  });
});

describe('performance', () => {
  test('reports cold load and 2,000-statement parse timings', async () => {
    const loadStart = performance.now();
    await ensureLoaded();
    const loadMs = performance.now() - loadStart;
    const sql = Array.from({ length: 2000 }, (_, index) => `ALTER TABLE t${index} ADD COLUMN c int;`).join('\n');
    const parseStart = performance.now();
    const statements = parseStatements(sql);
    const parseMs = performance.now() - parseStart;
    console.log(`TIMING loadModule=${loadMs.toFixed(0)}ms parse2000=${parseMs.toFixed(0)}ms`);
    assert.equal(statements.length, 2000);
    assert.ok(statements.every((statement) => !statement.error));
  });
});
