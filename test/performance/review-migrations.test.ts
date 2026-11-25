import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { extractCodeFile } from '../../lib/performance/migrations/extract-code.js';
import { extractSqlText, prepareDialect } from '../../lib/performance/migrations/extract-sql.js';
import { annotateUnit } from '../../lib/performance/migrations/operations.js';
import { checkMysqlUnit } from '../../lib/performance/migrations/rules-mysql.js';
import { checkPostgresUnit } from '../../lib/performance/migrations/rules-postgres.js';
import type { MigrationDialect } from '../../lib/performance/types/migration-operations.js';
import type { Finding } from '../../lib/shared/types.js';

const summary = (findings: Finding[]) => findings.map((finding: Finding) => [finding.ruleId, finding.line]);

interface CheckCodeOptions {
  dialect: MigrationDialect;
  framework: string;
  file?: string;
}

function checkCode(text: string, { dialect, framework, file = 'm.js' }: CheckCodeOptions) {
  const { units } = extractCodeFile(text, { file, dialect });
  return units.flatMap((unit) => {
    annotateUnit(unit.operations, { inTransaction: unit.inTransaction, dialect });
    const checkUnit = dialect === 'mysql' ? checkMysqlUnit : checkPostgresUnit;
    return checkUnit({ file, framework, dialect, operations: unit.operations });
  });
}

function checkPostgresSql(sql: string) {
  const { operations } = extractSqlText(sql, { dialect: 'postgres', file: 'm.sql' });
  annotateUnit(operations, { inTransaction: false, dialect: 'postgres' });
  return checkPostgresUnit({ file: 'm.sql', framework: 'sql', dialect: 'postgres', operations });
}

describe('migration review regressions', () => {
  before(() => prepareDialect('postgres'));

  test('MySQL raw queries in separate calls are separate statements', () => {
    const findings = checkCode(
      "exports.up = async (knex) => {\n  await knex.raw('ALTER TABLE users ADD INDEX idx_a (a)');\n  await knex.raw('ALTER TABLE orders ADD INDEX idx_b (b)');\n};\n",
      { dialect: 'mysql', framework: 'knex' },
    );
    assert.deepEqual(summary(findings), [
      ['migration-mysql-lock-unspecified', 2],
      ['migration-mysql-lock-unspecified', 3],
    ]);
  });

  test('MySQL builder calls are not grouped with an earlier CREATE TABLE', () => {
    const findings = checkCode(
      "exports.up = async (knex) => {\n  await knex.schema.createTable('fresh', (t) => { t.increments('id'); });\n  await knex.schema.alterTable('users', (t) => { t.string('name', 500).alter(); });\n};\n",
      { dialect: 'mysql', framework: 'knex' },
    );
    assert.deepEqual(summary(findings), [['migration-mysql-table-copy', 3]]);
  });

  test('TypeORM `isPrimary: false` keeps the column NOT NULL', () => {
    const findings = checkCode(
      "import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';\nexport class A implements MigrationInterface {\n  async up(queryRunner: QueryRunner) {\n    await queryRunner.addColumn('users', new TableColumn({ name: 'age', type: 'int', isPrimary: false }));\n  }\n}\n",
      { dialect: 'postgres', framework: 'typeorm', file: 'm.ts' },
    );
    assert.ok(summary(findings).some(([ruleId]) => ruleId === 'migration-not-null-without-default'));
  });

  test('Knex `dropNullable` is SET NOT NULL, not an added column', () => {
    const findings = checkCode(
      "exports.up = async (knex) => {\n  await knex.schema.alterTable('users', (t) => { t.dropNullable('email'); });\n};\n",
      { dialect: 'postgres', framework: 'knex' },
    );
    assert.ok(summary(findings).some(([ruleId, line]) => ruleId === 'migration-set-not-null-scan' && line === 2));
  });

  for (const statement of ['RESET lock_timeout;', 'SET lock_timeout TO DEFAULT;']) {
    test(`\`${statement}\` does not count as setting lock_timeout`, () => {
      const findings = checkPostgresSql(statement + '\nALTER TABLE users DROP CONSTRAINT users_old;');
      assert.ok(summary(findings).some(([ruleId, line]) => ruleId === 'migration-missing-lock-timeout' && line === 2));
    });
  }

  test("`SET LOCAL lock_timeout = '5s'` still counts", () => {
    const findings = checkPostgresSql("SET LOCAL lock_timeout = '5s';\nALTER TABLE users DROP CONSTRAINT users_old;");
    assert.ok(!summary(findings).some(([ruleId]) => ruleId === 'migration-missing-lock-timeout'));
  });
});
