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

describe('Postgres column rules', () => {
  before(() => prepareDialect('postgres'));

  test('NOT NULL column without a default on an existing table', () => {
    const findings = checkSql(withLockTimeout('ALTER TABLE "Order" ADD COLUMN "state" text NOT NULL;'));
    assert.deepEqual(rules(findings), ['migration-not-null-without-default']);
    assertFindingShape(findings[0]);
    assert.match(findings[0].message, /^`ADD COLUMN state \.\.\. NOT NULL` has no default, so it fails on `"Order"`/);
    assert.match(findings[0].message, /Add it nullable \(or with a constant `DEFAULT`/);
  });

  test('NOT NULL with a constant default, identity, nullable columns and new tables are silent', () => {
    const sql = withLockTimeout(
      "ALTER TABLE orders ADD COLUMN state text NOT NULL DEFAULT 'new';\n" +
        'ALTER TABLE orders ADD COLUMN note text;\n' +
        'ALTER TABLE orders ADD COLUMN created timestamptz NOT NULL DEFAULT now();\n' +
        'ALTER TABLE orders ADD COLUMN stamp timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;\n' +
        "ALTER TABLE orders ADD COLUMN tags text[] NOT NULL DEFAULT '{}'::text[];\n" +
        'CREATE TABLE fresh (id int);\nALTER TABLE fresh ADD COLUMN state text NOT NULL;',
    );
    assert.deepEqual(rules(checkSql(sql)), []);
  });

  test('builder columns use framework wording; Sequelize client-side UUIDV4 is not a database default', () => {
    const findings = checkCode(
      "module.exports = { async up(queryInterface, Sequelize) { await queryInterface.sequelize.query(\"SET lock_timeout = '5s'\"); await queryInterface.addColumn('Reports', 'uid', { type: Sequelize.UUID, allowNull: false, defaultValue: Sequelize.UUIDV4 }); } };",
      'm.cjs',
    );
    assert.deepEqual(rules(findings), ['migration-not-null-without-default']);
    assert.match(findings[0].message, /Add it with `allowNull: true`/);
  });

  test('volatile defaults, serial and identity columns rewrite the table', () => {
    const findings = checkSql(
      withLockTimeout(
        'ALTER TABLE "Order" ADD COLUMN "publicId" uuid NOT NULL DEFAULT gen_random_uuid();\n' +
          'ALTER TABLE orders ADD COLUMN seq bigserial;\n' +
          'ALTER TABLE orders ADD COLUMN n int GENERATED ALWAYS AS IDENTITY;\n' +
          'ALTER TABLE orders ADD COLUMN r float8 DEFAULT random() * 10;\n' +
          'ALTER TABLE orders ADD COLUMN c text DEFAULT custom_fn();',
      ),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.ruleId, finding.line]),
      [
        ['migration-volatile-default', 2],
        ['migration-volatile-default', 3],
        ['migration-volatile-default', 4],
        ['migration-volatile-default', 5],
        ['migration-volatile-default', 6],
      ],
    );
    assertFindingShape(findings[0]);
    assert.equal(
      findings[0].message,
      '`DEFAULT gen_random_uuid()` is volatile, so `ADD COLUMN "publicId"` rewrites the whole `"Order"` table under an ' +
        'ACCESS EXCLUSIVE lock, blocking reads and writes until it finishes. Add the column without a default, then ' +
        '`ALTER TABLE "Order" ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid();` so only new rows get it, and ' +
        'backfill existing rows in batches. A constant or `now()` default would be instant.',
    );
  });

  test('a default built from a template hole is not judged', () => {
    const findings = checkCode(
      'export class M implements MigrationInterface { async up(queryRunner: QueryRunner) { await queryRunner.query("SET lock_timeout = \'5s\'"); await queryRunner.query(`ALTER TABLE t ADD COLUMN a text DEFAULT ${value}`); } }',
    );
    assert.deepEqual(rules(findings), []);
  });

  test('column type changes rewrite unless they are known safe widenings', () => {
    const registry = createPostgresRegistry();
    checkSql(
      'CREATE TABLE orders (code varchar(20), total numeric(10,2), qty int, name text, label varchar(50));',
      'sql',
      registry,
    );
    const findings = checkSql(
      withLockTimeout(
        'ALTER TABLE orders ALTER COLUMN code TYPE varchar(40);\n' +
          'ALTER TABLE orders ALTER COLUMN total TYPE numeric(12,2);\n' +
          'ALTER TABLE orders ALTER COLUMN name TYPE varchar;\n' +
          'ALTER TABLE orders ALTER COLUMN qty TYPE bigint;\n' +
          'ALTER TABLE orders ALTER COLUMN label TYPE varchar(10);\n' +
          'ALTER TABLE orders ALTER COLUMN code TYPE text;',
      ),
      'sql',
      registry,
    );
    assert.deepEqual(
      findings.map((finding) => [finding.ruleId, finding.line]),
      [
        ['migration-column-type-rewrite', 5],
        ['migration-column-type-rewrite', 6],
      ],
    );
    assertFindingShape(findings[0]);
    assert.match(findings[0].message, /^`ALTER COLUMN qty TYPE bigint` from `integer` to `bigint` rewrites `orders`/);
  });

  test('a type change with an unknown previous type is reported with the widening caveat', () => {
    const [finding] = checkSql(withLockTimeout('ALTER TABLE orders ALTER COLUMN code TYPE varchar(64);'));
    assert.equal(finding.ruleId, 'migration-column-type-rewrite');
    assert.match(finding.message, /If `code` is currently a shorter `varchar`/);
    assert.deepEqual(rules(checkSql('CREATE TABLE t (a int);\nALTER TABLE t ALTER COLUMN a TYPE bigint;')), []);
  });

  test('SET NOT NULL scans unless a validated CHECK (col IS NOT NULL) exists', () => {
    const findings = checkSql(withLockTimeout('ALTER TABLE "Order" ALTER COLUMN "state" SET NOT NULL;'));
    assert.deepEqual(rules(findings), ['migration-set-not-null-scan']);
    assertFindingShape(findings[0]);
    assert.match(findings[0].message, /CHECK \(state IS NOT NULL\) NOT VALID;`, then in a later migration/);

    const registry = createPostgresRegistry();
    checkSql('ALTER TABLE orders ADD CONSTRAINT orders_state_nn CHECK (state IS NOT NULL) NOT VALID;', 'sql', registry);
    assert.deepEqual(
      rules(checkSql(withLockTimeout('ALTER TABLE orders ALTER COLUMN state SET NOT NULL;'), 'sql', registry)),
      ['migration-set-not-null-scan'],
    );
    checkSql('ALTER TABLE orders VALIDATE CONSTRAINT orders_state_nn;', 'sql', registry);
    assert.deepEqual(
      rules(checkSql(withLockTimeout('ALTER TABLE orders ALTER COLUMN state SET NOT NULL;'), 'sql', registry)),
      [],
    );
  });
});

describe('Postgres constraint rules', () => {
  before(() => prepareDialect('postgres'));

  test('FOREIGN KEY and CHECK without NOT VALID on an existing table', () => {
    const findings = checkSql(
      withLockTimeout(
        'ALTER TABLE "Order" ADD CONSTRAINT "Order_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id");\n' +
          'ALTER TABLE orders ADD CONSTRAINT positive CHECK (total > 0);',
      ),
    );
    assert.deepEqual(rules(findings), ['migration-constraint-not-valid', 'migration-constraint-not-valid']);
    assertFindingShape(findings[0]);
    assert.equal(
      findings[0].message,
      '`ADD CONSTRAINT "Order_storeId_fkey" FOREIGN KEY` on existing table `"Order"` checks every row while holding ' +
        'a SHARE ROW EXCLUSIVE lock on it and on the referenced table, blocking writes to both. Add `NOT VALID`, then ' +
        'run `ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_storeId_fkey";` in a later migration; validation takes a ' +
        'lock that allows reads and writes. New and updated rows are checked as soon as the `NOT VALID` constraint exists.',
    );
    assert.match(findings[1].message, /ACCESS EXCLUSIVE lock/);
  });

  test('NOT VALID, constraints on new tables and VALIDATE outside a transaction are silent', () => {
    const sql = withLockTimeout(
      'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id) NOT VALID;\n' +
        'ALTER TABLE orders VALIDATE CONSTRAINT fk;\n' +
        'CREATE TABLE fresh (a int);\nALTER TABLE fresh ADD CONSTRAINT fk2 FOREIGN KEY (a) REFERENCES u(id);\n' +
        'ALTER TABLE fresh ADD CONSTRAINT u UNIQUE (a);',
    );
    assert.deepEqual(rules(checkSql(sql)), []);
  });

  test('VALIDATE in the same transaction as its NOT VALID add', () => {
    const sql = withLockTimeout(
      'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id) NOT VALID;\n' +
        'ALTER TABLE orders VALIDATE CONSTRAINT fk;',
    );
    const findings = checkSql(sql, 'prisma');
    assert.deepEqual(rules(findings), ['migration-constraint-not-valid']);
    assert.equal(findings[0].line, 3);
    assert.match(findings[0].message, /same transaction as its `NOT VALID` add/);
  });

  test('UNIQUE and PRIMARY KEY without USING INDEX', () => {
    const findings = checkSql(
      withLockTimeout(
        'ALTER TABLE orders ADD CONSTRAINT orders_code_key UNIQUE (code);\n' +
          'ALTER TABLE orders ADD PRIMARY KEY (id);\n' +
          'ALTER TABLE orders ADD CONSTRAINT orders_ref_key UNIQUE USING INDEX orders_ref_idx;',
      ),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.ruleId, finding.line]),
      [
        ['migration-constraint-without-index', 2],
        ['migration-constraint-without-index', 3],
      ],
    );
    assertFindingShape(findings[0]);
    assert.match(
      findings[0].message,
      /Build the index first with `CREATE UNIQUE INDEX CONCURRENTLY orders_code_key ON orders \(\.\.\.\);`/,
    );
    assert.match(findings[1].message, /primary key also needs NOT NULL columns/);
  });

  test('Knex unique() and TypeORM createForeignKey are builder constraints', () => {
    const knex = checkCode(
      "exports.up = async (knex) => { await knex.raw(\"SET lock_timeout = '5s'\"); await knex.schema.alterTable('orders', (t) => { t.unique(['code']); }); };",
      'm.js',
    );
    assert.deepEqual(rules(knex), ['migration-constraint-without-index']);
    const typeorm = checkCode(
      "export class F implements MigrationInterface { async up(queryRunner: QueryRunner) { await queryRunner.query(\"SET lock_timeout = '5s'\"); await queryRunner.createForeignKey('orders', new TableForeignKey({})); } }",
    );
    assert.deepEqual(rules(typeorm), ['migration-constraint-not-valid']);
    assert.match(typeorm[0].message, /Add it with a raw query ending in `NOT VALID`/);
  });
});

describe('Postgres compatibility rules', () => {
  before(() => prepareDialect('postgres'));

  test('DROP COLUMN and DROP TABLE on existing tables', () => {
    const findings = checkSql(
      withLockTimeout('ALTER TABLE "Order" DROP COLUMN "legacy";\nDROP TABLE IF EXISTS old_audit;'),
    );
    assert.deepEqual(rules(findings), ['migration-breaking-drop', 'migration-breaking-drop']);
    assertFindingShape(findings[0]);
    assert.equal(
      findings[0].message,
      '`DROP COLUMN legacy` breaks app versions still running during the deploy, because they still read or write ' +
        '`"Order".legacy`. Remove all reads and writes (and the ORM field), deploy, then drop it in a later release. ' +
        'If no deployed version uses it any more, mark it reviewed.',
    );
    assert.deepEqual(rules(checkSql('CREATE TABLE tmp (a int);\nDROP TABLE tmp;')), []);
  });

  test('a dropped column named by a template hole is still reported, by table', () => {
    const findings = checkCode(
      'export class D implements MigrationInterface { async up(queryRunner: QueryRunner) { await queryRunner.query("SET lock_timeout = \'5s\'"); for (const column of columns) { await queryRunner.query(`ALTER TABLE "admissions" DROP COLUMN "${column}"`); } } }',
    );
    assert.deepEqual(rules(findings), ['migration-breaking-drop']);
    assert.match(findings[0].message, /`DROP COLUMN \$\{\.\.\.\}`/);
  });

  test('column and table renames; index renames are fine', () => {
    const findings = checkSql(
      withLockTimeout(
        'ALTER TABLE orders RENAME COLUMN total TO amount;\nALTER TABLE orders RENAME TO purchases;\nALTER INDEX i RENAME TO j;',
      ),
    );
    assert.deepEqual(rules(findings), ['migration-breaking-rename', 'migration-breaking-rename']);
    assertFindingShape(findings[0]);
    assert.match(findings[0].message, /^`RENAME COLUMN total TO amount` breaks app versions still running/);
    assert.match(findings[0].message, /Add amount, dual-write both columns, switch reads to amount, then drop total/);
  });

  test('parser rejections are findings, contextual when the SQL has template holes', () => {
    const [finding] = checkSql('CREATE INDX i ON t (a);');
    assert.equal(finding.ruleId, 'migration-unparsed');
    assert.match(finding.message, /syntax error at or near "INDX"` at line 1/);
    assert.equal(finding.contextualReason, undefined);

    const dynamic = checkCode(
      'export class X implements MigrationInterface { async up(queryRunner: QueryRunner) { await queryRunner.query(`CREATE INDEX i ON t (${columns.join(", ")}) WHERE`); } }',
    );
    assert.equal(dynamic[0].ruleId, 'migration-unparsed');
    assert.match(dynamic[0].contextualReason, /interpolated/);
  });

  test('data statements produce no findings', () => {
    assert.deepEqual(rules(checkSql('INSERT INTO t VALUES (1);\nUPDATE t SET a = 2;\nDELETE FROM t WHERE a = 3;')), []);
  });
});
