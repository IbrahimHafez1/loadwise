'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, describe, test } = require('node:test');

const { extractCodeFile } = require('../lib/migrations/extract-code.cjs');
const { extractSqlText, prepareDialect, sqlFileInTransaction } = require('../lib/migrations/extract-sql.cjs');
const { annotateUnit } = require('../lib/migrations/operations.cjs');
const { checkPostgresUnit, createPostgresRegistry } = require('../lib/migrations/rules-postgres.cjs');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'migrations', name), 'utf8');

function checkSql(sql, framework = 'sql', registry = createPostgresRegistry()) {
  const { operations, statementCount } = extractSqlText(sql, { dialect: 'postgres', file: 'm.sql' });
  annotateUnit(operations, { inTransaction: sqlFileInTransaction(framework, statementCount), dialect: 'postgres' });
  return checkPostgresUnit({ file: 'm.sql', framework, operations }, registry);
}

function checkCode(text, file = 'migration.ts', registry = createPostgresRegistry()) {
  const { framework, units } = extractCodeFile(text, { file, dialect: 'postgres' });
  return units.flatMap((unit) => {
    annotateUnit(unit.operations, { inTransaction: unit.inTransaction, dialect: 'postgres' });
    return checkPostgresUnit({ file, framework, operations: unit.operations }, registry);
  });
}

const rules = (findings) => findings.map((finding) => finding.ruleId);
const only = (findings, ruleId) => findings.filter((finding) => finding.ruleId === ruleId);
const withLockTimeout = (sql) => "SET lock_timeout = '5s';\n" + sql;

function assertFindingShape(finding) {
  assert.equal(typeof finding.message, 'string');
  assert.equal(typeof finding.suggestion, 'string');
  assert.equal(typeof finding.example.before, 'string');
  assert.equal(typeof finding.example.after, 'string');
}

describe('Postgres locking rules', () => {
  before(() => prepareDialect('postgres'));

  test('CREATE INDEX on an existing table without CONCURRENTLY, worded for Prisma', () => {
    const findings = checkSql(withLockTimeout('CREATE INDEX "order_created_idx" ON "Order" ("createdAt");'), 'prisma');
    const [finding] = only(findings, 'migration-index-not-concurrent');
    assertFindingShape(finding);
    assert.equal(finding.line, 2);
    assert.equal(
      finding.message,
      '`CREATE INDEX "order_created_idx"` on existing table `"Order"` blocks writes for the whole build. ' +
        'Use `CREATE INDEX CONCURRENTLY "order_created_idx" ON "Order" ("createdAt")` in a migration file containing ' +
        'only this statement, because Prisma runs a multi-statement file in one transaction. ' +
        'A failed concurrent build leaves an invalid index; drop it and retry.',
    );
    assert.equal(finding.example.after, 'CREATE INDEX CONCURRENTLY "order_created_idx" ON "Order" ("createdAt")');
  });

  test('CONCURRENTLY outside a transaction, on a new table and ON ONLY parents are silent', () => {
    assert.deepEqual(rules(checkSql('CREATE INDEX CONCURRENTLY i ON orders (a);', 'prisma')), []);
    assert.deepEqual(rules(checkSql('CREATE TABLE fresh (a int);\nCREATE INDEX i ON fresh (a);')), []);
    assert.deepEqual(rules(checkSql(withLockTimeout('CREATE INDEX i ON ONLY measurements (a);'))), []);
  });

  test('CONCURRENTLY inside a transaction fails at run time', () => {
    const prisma = checkSql(withLockTimeout('CREATE INDEX CONCURRENTLY i ON orders (a);'), 'prisma');
    assert.deepEqual(rules(prisma), ['migration-concurrent-in-transaction']);
    assert.match(prisma[0].message, /Move it to a migration file containing only this statement/);

    const explicit = checkSql('BEGIN;\nDROP INDEX CONCURRENTLY i;\nCOMMIT;\nDROP INDEX CONCURRENTLY j;');
    assert.deepEqual(rules(explicit), ['migration-concurrent-in-transaction']);
    assert.equal(explicit[0].line, 2);
    assert.match(explicit[0].message, /Move it after `COMMIT`/);

    const drizzle = checkSql('CREATE INDEX CONCURRENTLY i ON orders (a);', 'drizzle');
    assert.match(drizzle[0].message, /outside the Drizzle migrator/);
  });

  test('TypeORM: transaction = false allows CONCURRENTLY; the default transaction does not', () => {
    const migration = (transactionLine) => `
      export class AddIndex1 implements MigrationInterface {
        ${transactionLine}
        async up(queryRunner: QueryRunner) {
          await queryRunner.query("SET lock_timeout = '5s'");
          await queryRunner.query('CREATE INDEX CONCURRENTLY "i" ON "orders" ("a")');
        }
      }`;
    assert.deepEqual(rules(checkCode(migration('transaction = false;'))), []);
    const findings = checkCode(migration(''));
    assert.deepEqual(rules(findings), ['migration-concurrent-in-transaction']);
    assert.match(findings[0].message, /Set `transaction = false` on the migration class/);
  });

  test('builder indexes get framework fixes', () => {
    const sequelize = checkCode(
      "module.exports = { async up(queryInterface) { await queryInterface.sequelize.query(\"SET lock_timeout = '5s'\"); await queryInterface.addIndex('Reports', ['code']); } };",
      'm.cjs',
    );
    assert.deepEqual(rules(sequelize), ['migration-index-not-concurrent']);
    assert.match(
      sequelize[0].message,
      /Pass `\{ concurrently: true \}` to `queryInterface.addIndex\('Reports', \.\.\.\)`/,
    );
  });

  test('missing lock_timeout fires once per file, on the first lock-taking statement', () => {
    const findings = only(
      checkSql('CREATE TABLE fresh (a int);\nALTER TABLE orders ADD COLUMN note text;\nDROP INDEX j;'),
      'migration-missing-lock-timeout',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 2);
    assertFindingShape(findings[0]);
    assert.match(findings[0].message, /Start the migration with `SET lock_timeout = '5s';`/);
    assert.equal(findings[0].example.after, "SET lock_timeout = '5s'; ALTER TABLE orders ADD COLUMN note text");
  });

  test('masrmart-style file with SET lock_timeout is silent for that rule', () => {
    const findings = checkSql(fixture('prisma-lock-timeout.sql'), 'prisma');
    assert.deepEqual(only(findings, 'migration-missing-lock-timeout'), []);
    assert.deepEqual(rules(findings), ['migration-index-not-concurrent']);
  });

  test('k12-style create-table-then-index is silent', () => {
    const findings = checkCode(fixture('typeorm-create-table-then-index.ts'));
    assert.deepEqual(findings, []);
  });

  test('VACUUM FULL, CLUSTER and plain REINDEX rewrite or block; REINDEX CONCURRENTLY outside a transaction is fine', () => {
    const findings = only(
      checkSql(
        'VACUUM FULL orders;\nCLUSTER orders USING i;\nREINDEX TABLE orders;\nREINDEX TABLE CONCURRENTLY orders;\nVACUUM orders;',
      ),
      'migration-table-rewrite-command',
    );
    assert.deepEqual(
      findings.map((finding) => finding.line),
      [1, 2, 3],
    );
    assert.match(findings[0].message, /pg_repack/);
    assert.equal(findings[2].example.after, 'REINDEX TABLE CONCURRENTLY orders');
  });
});
