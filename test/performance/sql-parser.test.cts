import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';

import { byteOffsetToPosition, createPositionIndex, positionInTemplate } from '../../lib/performance/sql/locations.cjs';
import { ensureLoaded, parseExplainCandidate, parseStatements } from '../../lib/performance/sql/pg-parser.cjs';
import { parseMysqlStatements } from '../../lib/performance/sql/mysql-tokens.cjs';
import type { AlterTableCmd } from '@pgsql/types';
import type {
  ExplainCandidate,
  ParseErrorInfo,
  PgStatement,
  PgStatementNode,
} from '../../lib/performance/types/pg-statements.cjs';
import type { AlterAction, MysqlStatement } from '../../lib/performance/types/mysql-statements.cjs';
import { spawnSync } from 'node:child_process';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'sql', name), 'utf8');
const kinds = (statements: readonly { kind: string | null }[]) => statements.map((statement) => statement.kind);
const only = (sql: string) => parseStatements(sql)[0];

// The member of the first statement's node for `key`, such as IndexStmt.
function nodeMember<Key extends keyof PgStatementNode>(sql: string, key: Key): NonNullable<PgStatementNode[Key]> {
  const { node } = only(sql);
  assert.ok(node, 'the statement should parse');
  const member = node[key];
  assert.ok(member, `expected a ${String(key)}`);
  return member;
}

// The first command of the first ALTER TABLE statement.
function alterCommand(sql: string): AlterTableCmd {
  const wrapper = nodeMember(sql, 'AlterTableStmt').cmds?.[0];
  assert.ok(wrapper && 'AlterTableCmd' in wrapper, 'expected an ALTER TABLE command');
  return wrapper.AlterTableCmd;
}

function errorOf(statement: PgStatement): ParseErrorInfo {
  assert.ok(statement.error, 'expected a syntax error');
  return statement.error;
}

type ClassifiedCandidate = Exclude<ExplainCandidate, { error: ParseErrorInfo }>;

function classify(sql: string): ClassifiedCandidate {
  const candidate = parseExplainCandidate(sql);
  assert.ok('kind' in candidate, 'expected the statement to be classified');
  return candidate;
}

function isKind<Kind extends MysqlStatement['kind']>(
  statement: MysqlStatement,
  kind: Kind,
): statement is Extract<MysqlStatement, { kind: Kind }> {
  return statement.kind === kind;
}

// The column, or else the index, an ALTER TABLE action names.
function targetOf(action: AlterAction): string | null | undefined {
  return ('column' in action ? action.column : null) ?? ('index' in action ? action.index : undefined);
}

function startOf(action: AlterAction): number {
  assert.ok(action.start !== undefined, 'expected the action to carry its start offset');
  return action.start;
}

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
    const script = "require('./lib/performance/sql/pg-parser.cjs').parseStatements('SELECT 1')";
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
    });
    assert.match(result.stderr, /await ensureLoaded/);
  });

  test('CREATE INDEX with and without CONCURRENTLY', () => {
    const plain = nodeMember('CREATE INDEX i ON t (a)', 'IndexStmt');
    const concurrent = nodeMember('CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)', 'IndexStmt');
    assert.equal(Boolean(plain.concurrent), false);
    assert.equal(concurrent.concurrent, true);
    assert.equal(concurrent.unique, true);
  });

  test('ALTER TABLE column and constraint commands', () => {
    const command = alterCommand('ALTER TABLE t ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid()');
    assert.equal(command.subtype, 'AT_AddColumn');
    assert.ok(command.def && 'ColumnDef' in command.def, 'expected a column definition');
    assert.equal(command.def.ColumnDef.constraints?.length, 2);

    const subtypeOf = (sql: string) => alterCommand(sql).subtype;
    assert.equal(subtypeOf('ALTER TABLE t ALTER COLUMN a SET NOT NULL'), 'AT_SetNotNull');
    assert.equal(subtypeOf('ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID'), 'AT_AddConstraint');
    assert.equal(subtypeOf('ALTER TABLE t VALIDATE CONSTRAINT c'), 'AT_ValidateConstraint');
    assert.equal(subtypeOf('ALTER TABLE t DROP COLUMN a'), 'AT_DropColumn');
    const { def } = alterCommand('ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID');
    assert.ok(def && 'Constraint' in def, 'expected a constraint');
    assert.equal(def.Constraint.skip_validation, true);
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
    assert.equal(errorOf(statements[1]).line, 2);
    assert.match(errorOf(statements[1]).message, /syntax error/);
    assert.equal(statements[2].line, 3);
  });

  test('line and column stay correct with multibyte Arabic text', () => {
    const text = fixture('arabic.sql');
    const statements = parseStatements(text);
    assert.deepEqual(kinds(statements), ['InsertStmt', null, 'IndexStmt']);
    assert.equal(statements[0].line, 2);
    assert.equal(statements[1].line, 3);
    assert.equal(errorOf(statements[1]).line, 3);

    const index = statements[2];
    assert.equal(index.line, 4);
    const tableLocation = index.node?.IndexStmt?.relation?.location;
    assert.ok(tableLocation !== undefined, 'expected the index table to carry a location');
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
    assert.equal(classify('SELECT * INTO copy FROM t').hasInto, true);
    assert.equal(classify('SELECT * FROM t FOR UPDATE').hasLockingClause, true);
    assert.equal(classify('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d').hasDataModifyingCte, true);
    assert.equal(classify('DELETE FROM t').kind, 'DeleteStmt');
    assert.ok('error' in parseExplainCandidate('SELECT 1; SELECT 2'));
    assert.ok('error' in parseExplainCandidate('SELECT FROM WHERE'));
  });
});

describe('mysql tokenizer and recognizer', () => {
  const only1 = (sql: string) => parseMysqlStatements(sql)[0];

  // The first statement of `sql`, which must be of the given kind.
  function only1Of<Kind extends MysqlStatement['kind']>(sql: string, kind: Kind) {
    const statement = only1(sql);
    assert.ok(isKind(statement, kind), `expected a ${kind} statement`);
    return statement;
  }

  test('ALTER TABLE sub-commands', () => {
    const statement = only1Of(
      'ALTER TABLE `db`.`t` ADD COLUMN a INT NOT NULL, DROP COLUMN b, MODIFY c BIGINT, CHANGE d e INT, ' +
        'RENAME COLUMN f TO g, ADD INDEX i (a), DROP PRIMARY KEY, CONVERT TO CHARACTER SET utf8mb4, ' +
        'ALGORITHM=COPY, LOCK=SHARED',
      'alter-table',
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
    const [addColumn, , , changeColumn] = statement.actions;
    assert.ok(addColumn.type === 'add-column' && changeColumn.type === 'change-column');
    assert.equal(addColumn.notNull, true);
    assert.equal(addColumn.hasDefault, false);
    assert.equal(changeColumn.newName, 'e');
    assert.equal(statement.algorithm, 'COPY');
    assert.equal(statement.lock, 'SHARED');
  });

  test('CREATE INDEX, DROP and RENAME TABLE', () => {
    const [createIndex, dropTable, dropIndex, rename] = parseMysqlStatements(
      'CREATE UNIQUE INDEX i ON t (a) ALGORITHM=INPLACE LOCK=NONE;\n' +
        'DROP TABLE IF EXISTS a, `b`;\nDROP INDEX i ON t;\nRENAME TABLE a TO b, c TO d;',
    );
    assert.ok(isKind(createIndex, 'create-index') && isKind(dropTable, 'drop-table') && isKind(rename, 'rename-table'));
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
    const alterTable = statements[1];
    assert.ok(isKind(alterTable, 'alter-table'));
    assert.equal(alterTable.lock, 'NONE');
  });

  test('IF [NOT] EXISTS is skipped before names', () => {
    const statement = only1Of(
      'ALTER TABLE IF EXISTS t DROP COLUMN IF EXISTS a, ADD COLUMN IF NOT EXISTS b INT NOT NULL, ' +
        'MODIFY COLUMN IF EXISTS c INT, CHANGE IF EXISTS d e INT, DROP INDEX IF EXISTS i, RENAME COLUMN IF EXISTS f TO g',
      'alter-table',
    );
    assert.equal(statement.table, 't');
    assert.deepEqual(
      statement.actions.map((action) => [
        action.type,
        targetOf(action),
        'newName' in action ? action.newName : undefined,
      ]),
      [
        ['drop-column', 'a', undefined],
        ['add-column', 'b', undefined],
        ['modify-column', 'c', undefined],
        ['change-column', 'd', 'e'],
        ['drop-index', 'i', undefined],
        ['rename-column', 'f', 'g'],
      ],
    );
    assert.equal(only1Of('CREATE INDEX IF NOT EXISTS idx ON t (a)', 'create-index').index, 'idx');
    assert.equal(only1Of('DROP INDEX IF EXISTS idx ON t', 'drop-index').index, 'idx');
    assert.deepEqual(
      only1Of('DROP TABLE IF EXISTS a, b', 'drop-table').tables.map((entry) => entry.table),
      ['a', 'b'],
    );
  });

  test('each ALTER TABLE action carries its own start offset', () => {
    const sql = 'ALTER TABLE t\n  DROP COLUMN a,\n  MODIFY b INT';
    const { actions } = only1Of(sql, 'alter-table');
    assert.deepEqual(
      actions.map((action) => sql.slice(startOf(action), startOf(action) + 6)),
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
