'use strict';

const assert = require('node:assert/strict');
const { before, describe, test } = require('node:test');

const { extractSqlText, prepareDialect, sqlFileInTransaction } = require('../lib/migrations/extract-sql.cjs');

const postgres = (sql) => extractSqlText(sql, { dialect: 'postgres', file: 'm.sql' }).operations;
const mysql = (sql) => extractSqlText(sql, { dialect: 'mysql', file: 'm.sql' }).operations;
const kinds = (operations) => operations.map((operation) => operation.kind);

describe('Postgres SQL extraction', () => {
  before(() => prepareDialect('postgres'));

  test('maps DDL statements to operations with statement positions', () => {
    const operations = postgres(
      [
        '-- header',
        "SET lock_timeout = '5s';",
        'CREATE TABLE "Fresh" (id int, name varchar(20));',
        'CREATE INDEX CONCURRENTLY i ON t (a);',
        'DROP TABLE a, b;',
        'DROP INDEX CONCURRENTLY j;',
        'ALTER TABLE t RENAME COLUMN a TO b;',
        'ALTER TABLE t RENAME TO u;',
        'ALTER INDEX i RENAME TO k;',
        'BEGIN;',
        'COMMIT;',
        'VACUUM FULL t;',
        'CLUSTER t USING i;',
        'REINDEX INDEX CONCURRENTLY i;',
        'INSERT INTO t VALUES (1);',
        'CREATE TRIGGER g BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();',
      ].join('\n'),
    );
    assert.deepEqual(kinds(operations), [
      'set-lock-timeout',
      'create-table',
      'create-index',
      'drop-table',
      'drop-table',
      'drop-index',
      'rename-column',
      'rename-table',
      'other',
      'transaction-begin',
      'transaction-end',
      'table-rewrite-command',
      'table-rewrite-command',
      'table-rewrite-command',
      'data',
      'alter-table-other',
    ]);
    assert.deepEqual(operations[1].columns[1], {
      name: 'name',
      type: { name: 'varchar', modifiers: [20], array: false },
    });
    assert.equal(operations[2].concurrent, true);
    assert.equal(operations[2].line, 4);
    assert.deepEqual(
      operations.slice(3, 5).map((operation) => operation.table),
      ['a', 'b'],
    );
    assert.equal(operations[13].concurrent, true);
  });

  test('describes ALTER TABLE sub-commands, each at its own position', () => {
    const operations = postgres(
      'ALTER TABLE t\n  ADD COLUMN a uuid NOT NULL DEFAULT gen_random_uuid(),\n' +
        '  ALTER COLUMN b TYPE numeric(12,2) USING b::numeric,\n' +
        '  ALTER COLUMN c SET NOT NULL,\n' +
        '  ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id) NOT VALID,\n' +
        '  ADD CONSTRAINT nn CHECK (c IS NOT NULL) NOT VALID,\n' +
        '  ADD CONSTRAINT uq UNIQUE USING INDEX uq_idx,\n' +
        '  VALIDATE CONSTRAINT fk,\n' +
        '  DROP COLUMN d,\n' +
        '  ALTER COLUMN e SET DEFAULT 1;',
    );
    assert.deepEqual(kinds(operations), [
      'add-column',
      'alter-column-type',
      'set-not-null',
      'add-constraint',
      'add-constraint',
      'add-constraint',
      'validate-constraint',
      'drop-column',
      'alter-table-other',
    ]);
    const [added, retyped, , foreignKey, check, unique] = operations;
    assert.equal(added.notNull, true);
    assert.equal(added.hasDefault, true);
    assert.equal(added.line, 2);
    assert.equal(added.column, 14);
    assert.deepEqual(retyped.type, { name: 'numeric', modifiers: [12, 2], array: false });
    assert.equal(retyped.hasUsing, true);
    assert.equal(foreignKey.constraintType, 'foreign');
    assert.equal(foreignKey.notValid, true);
    assert.equal(foreignKey.line, 5);
    assert.equal(check.checkNotNullColumn, 'c');
    assert.equal(unique.usingIndex, true);
    assert.ok(operations.every((operation) => operation.table === 't'));
  });

  test('serial, identity and disabled lock timeouts', () => {
    const [serial, identity, disabled, configured] = postgres(
      'ALTER TABLE t ADD COLUMN id bigserial;\n' +
        'ALTER TABLE t ADD COLUMN n int GENERATED ALWAYS AS IDENTITY;\n' +
        'SET lock_timeout = 0;\n' +
        "SELECT set_config('lock_timeout', '5s', true);",
    );
    assert.equal(serial.serial, true);
    assert.equal(identity.identity, true);
    assert.equal(disabled.kind, 'other');
    assert.equal(configured.kind, 'set-lock-timeout');
  });

  test('parse errors carry the mapped error position and dynamic placeholders are flagged', () => {
    const [ok, broken, dynamic] = postgres(
      'CREATE INDEX i ON t (a);\nCREATE INDX j ON t (b);\nCREATE INDEX k ON __bpc_dynamic_0 (c);',
    );
    assert.equal(ok.dynamic, false);
    assert.equal(broken.kind, 'unparsed');
    assert.equal(broken.parseError.line, 2);
    assert.match(broken.parseError.message, /syntax error/);
    assert.equal(dynamic.dynamic, true);
  });

  test('a byte order mark does not shift positions and offsets can be remapped', () => {
    const [index] = postgres('﻿CREATE INDEX i ON t (a);');
    assert.deepEqual([index.line, index.column], [1, 1]);
    const shifted = extractSqlText('\n  CREATE INDEX i ON t (a);', {
      dialect: 'postgres',
      file: 'x.ts',
      mapOffset: (offset) => ({ line: 100, column: offset }),
    }).operations[0];
    assert.deepEqual([shifted.line, shifted.column], [100, 3]);
  });

  test('statement positions stay correct after Arabic text', () => {
    const operations = postgres('INSERT INTO t (name) VALUES (\'مرحبا بالعالم\');\nCREATE INDEX i ON "العملاء" (a);');
    assert.equal(operations[1].table, 'العملاء');
    assert.deepEqual([operations[1].line, operations[1].column], [2, 1]);
  });
});

describe('MySQL SQL extraction', () => {
  test('maps ALTER TABLE actions with statement options', () => {
    const operations = mysql(
      'ALTER TABLE users ADD COLUMN a INT NOT NULL, DROP COLUMN b, MODIFY c BIGINT, ALGORITHM=INPLACE, LOCK=NONE;\n' +
        'ALTER TABLE users CHANGE old_name new_name INT, DROP PRIMARY KEY, CONVERT TO CHARACTER SET utf8mb4;\n' +
        'ALTER TABLE users ADD UNIQUE INDEX u (a), RENAME COLUMN x TO y, RENAME TO people;',
    );
    assert.deepEqual(kinds(operations), [
      'add-column',
      'drop-column',
      'alter-column-type',
      'rename-column',
      'alter-column-type',
      'drop-primary-key',
      'convert-charset',
      'create-index',
      'rename-column',
      'rename-table',
    ]);
    assert.equal(operations[0].notNull, true);
    assert.equal(operations[0].hasDefault, false);
    assert.equal(operations[0].algorithm, 'INPLACE');
    assert.equal(operations[0].lock, 'NONE');
    assert.equal(operations[3].newName, 'new_name');
    assert.equal(operations[7].unique, true);
    assert.equal(operations[9].line, 3);
  });

  test('places each ALTER TABLE action on its own line and skips IF EXISTS', () => {
    const operations = mysql(
      'ALTER TABLE users\n  DROP COLUMN IF EXISTS a,\n  ADD COLUMN IF NOT EXISTS b INT,\n  MODIFY c BIGINT;',
    );
    assert.deepEqual(
      operations.map((operation) => [operation.kind, operation.columnName, operation.line, operation.column]),
      [
        ['drop-column', 'a', 2, 3],
        ['add-column', 'b', 3, 3],
        ['alter-column-type', 'c', 4, 3],
      ],
    );
  });

  test('maps CREATE TABLE, CREATE INDEX, DROP, RENAME TABLE and data statements', () => {
    const operations = mysql(
      'CREATE TABLE IF NOT EXISTS `orders` (id INT);\nCREATE INDEX i ON orders (a) ALGORITHM=COPY;\n' +
        'DROP TABLE a, b;\nRENAME TABLE a TO b;\nINSERT INTO t VALUES (1);\nDROP INDEX i ON orders;',
    );
    assert.deepEqual(kinds(operations), [
      'create-table',
      'create-index',
      'drop-table',
      'drop-table',
      'rename-table',
      'data',
      'drop-index',
    ]);
    assert.equal(operations[0].table, 'orders');
    assert.equal(operations[1].algorithm, 'COPY');
    assert.equal(operations[4].newName, 'b');
  });
});

describe('SQL file transaction context', () => {
  test('Prisma wraps only multi-statement files, Drizzle wraps every file, plain SQL none', () => {
    assert.equal(sqlFileInTransaction('prisma', 1), false);
    assert.equal(sqlFileInTransaction('prisma', 2), true);
    assert.equal(sqlFileInTransaction('drizzle', 1), true);
    assert.equal(sqlFileInTransaction('sql', 5), false);
  });
});

describe('sub-command positions', () => {
  before(() => prepareDialect('postgres'));

  test('DROP COLUMN, SET NOT NULL and VALIDATE are placed at their names', () => {
    const operations = postgres(
      'ALTER TABLE "a" DROP COLUMN "a",\n  DROP COLUMN b,\n  ALTER COLUMN "C" SET NOT NULL,\n  VALIDATE CONSTRAINT c;',
    );
    assert.deepEqual(
      operations.map((operation) => [operation.kind, operation.line, operation.column]),
      [
        ['drop-column', 1, 29],
        ['drop-column', 2, 15],
        ['set-not-null', 3, 16],
        ['validate-constraint', 4, 23],
      ],
    );
  });
});
