'use strict';

const assert = require('node:assert/strict');
const { before, describe, test } = require('node:test');

const { extractSqlText, prepareDialect } = require('../../lib/performance/migrations/extract-sql.cjs');
const { annotateUnit } = require('../../lib/performance/migrations/operations.cjs');
const { checkPostgresUnit } = require('../../lib/performance/migrations/rules-postgres.cjs');

const summary = (findings) => findings.map((finding) => [finding.ruleId, finding.line]);

function checkPostgresSql(sql) {
  const { operations } = extractSqlText(sql, { dialect: 'postgres', file: 'm.sql' });
  annotateUnit(operations, { inTransaction: false, dialect: 'postgres' });
  return checkPostgresUnit({ file: 'm.sql', framework: 'sql', dialect: 'postgres', operations });
}

describe('migration review regressions', () => {
  before(() => prepareDialect('postgres'));

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
