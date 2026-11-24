import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  annotateUnit,
  compactSql,
  createFinding,
  createOperation,
  quoteIdentifier,
} from '../../lib/performance/migrations/operations.cjs';
import type {
  MigrationOperation,
  OperationInit,
  OperationPosition,
} from '../../lib/performance/types/migration-operations.cjs';

// `kind` stays a plain string so the test can hand the factory an unknown one.
type OperationFields = Omit<OperationInit, keyof OperationPosition | 'kind'> &
  Partial<OperationPosition> & { kind: string };

// `Reflect.apply` skips the `OperationInit` kind check so the test can hand the factory an unknown
// kind.
const operation = (fields: OperationFields): MigrationOperation =>
  Reflect.apply(createOperation, undefined, [{ file: 'm.sql', line: 1, column: 1, ...fields }]);

describe('migration operation IR', () => {
  test('fills defaults and rejects unknown kinds', () => {
    const created = operation({ kind: 'create-index', table: 't' });
    assert.equal(created.concurrent, false);
    assert.equal(created.inTransaction, false);
    assert.equal(created.dynamic, false);
    assert.throws(() => operation({ kind: 'explode' }), /Unknown migration operation kind/);
  });

  test('marks operations on a table created earlier in the unit, including after a rename', () => {
    const operations = annotateUnit(
      [
        operation({ kind: 'create-index', table: 'old' }),
        operation({ kind: 'create-table', table: 'fresh' }),
        operation({ kind: 'create-index', table: 'fresh' }),
        operation({ kind: 'rename-table', table: 'fresh', newName: 'renamed' }),
        operation({ kind: 'create-index', table: 'renamed' }),
      ],
      { inTransaction: false, dialect: 'postgres' },
    );
    assert.deepEqual(
      operations.map((entry) => entry.createdInSameUnit),
      [false, true, true, true, true],
    );
  });

  test('tracks explicit BEGIN and COMMIT on top of the framework default', () => {
    const operations = annotateUnit(
      [
        operation({ kind: 'create-index', table: 't' }),
        operation({ kind: 'transaction-begin' }),
        operation({ kind: 'create-index', table: 't' }),
        operation({ kind: 'transaction-end' }),
        operation({ kind: 'create-index', table: 't', explicitTransaction: true }),
      ],
      { inTransaction: false, dialect: 'postgres' },
    );
    assert.deepEqual(
      operations.map((entry) => entry.inTransaction),
      [false, true, true, false, true],
    );
  });

  test('MySQL table names compare case-insensitively, Postgres names exactly', () => {
    const mysql = annotateUnit(
      [operation({ kind: 'create-table', table: 'Users' }), operation({ kind: 'create-index', table: 'users' })],
      { inTransaction: false, dialect: 'mysql' },
    );
    assert.equal(mysql[1].createdInSameUnit, true);
    const postgres = annotateUnit(
      [operation({ kind: 'create-table', table: 'Users' }), operation({ kind: 'create-index', table: 'users' })],
      { inTransaction: false, dialect: 'postgres' },
    );
    assert.equal(postgres[1].createdInSameUnit, false);
  });

  test('formats identifiers, compact SQL and findings', () => {
    assert.equal(quoteIdentifier('orders'), 'orders');
    assert.equal(quoteIdentifier('Order'), '"Order"');
    assert.equal(quoteIdentifier('Order', 'mysql'), '`Order`');
    assert.equal(compactSql('CREATE INDEX i\n  ON t (a); -- note'), 'CREATE INDEX i ON t (a)');
    assert.ok(compactSql('SELECT ' + 'x, '.repeat(100)).endsWith('...'));
    const finding = createFinding(operation({ kind: 'drop-table', table: 't', line: 4, column: 2 }), 'rule-id', {
      message: 'm',
      suggestion: 's',
      example: { before: 'b', after: 'a' },
    });
    assert.deepEqual(finding, {
      file: 'm.sql',
      line: 4,
      column: 2,
      ruleId: 'rule-id',
      message: 'm',
      suggestion: 's',
      example: { before: 'b', after: 'a' },
    });
  });
});
