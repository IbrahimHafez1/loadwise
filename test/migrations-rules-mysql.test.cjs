'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { extractSqlText } = require('../lib/migrations/extract-sql.cjs');
const { annotateUnit } = require('../lib/migrations/operations.cjs');
const { checkMysqlUnit } = require('../lib/migrations/rules-mysql.cjs');

function check(sql) {
  const { operations } = extractSqlText(sql, { dialect: 'mysql', file: 'm.sql' });
  annotateUnit(operations, { inTransaction: false, dialect: 'mysql' });
  return checkMysqlUnit({ file: 'm.sql', framework: 'sql', dialect: 'mysql', operations });
}

const summary = (findings) => findings.map((finding) => [finding.ruleId, finding.line]);

describe('MySQL migration rules', () => {
  test('findings land on each ALTER TABLE sub-command line', () => {
    const findings = check(
      'ALTER TABLE orders\n  DROP COLUMN IF EXISTS legacy,\n  ADD COLUMN IF NOT EXISTS note INT NOT NULL,\n  MODIFY total BIGINT;',
    );
    const found = findings.map((finding) => [finding.ruleId, finding.line]);
    assert.ok(found.some(([ruleId, line]) => ruleId === 'migration-not-null-without-default' && line === 3));
    assert.ok(found.some(([ruleId, line]) => ruleId === 'migration-mysql-table-copy' && line === 4));
    assert.ok(found.some(([ruleId, line]) => ruleId === 'migration-breaking-drop' && line === 2));
  });

  test('known COPY operations', () => {
    const findings = check(
      'ALTER TABLE orders MODIFY total BIGINT, ALGORITHM=INPLACE, LOCK=NONE;\n' +
        'ALTER TABLE orders DROP PRIMARY KEY, ADD PRIMARY KEY (id, shop_id);\n' +
        'ALTER TABLE orders CONVERT TO CHARACTER SET utf8mb4;\n' +
        'ALTER TABLE orders ADD COLUMN note TEXT, ALGORITHM=COPY;',
    );
    assert.deepEqual(summary(findings), [
      ['migration-mysql-table-copy', 1],
      ['migration-mysql-table-copy', 2],
      ['migration-mysql-table-copy', 3],
      ['migration-mysql-table-copy', 4],
    ]);
    const [first] = findings;
    assert.match(
      first.message,
      /changes a column definition \(`MODIFY`\/`CHANGE`\), which MySQL does with `ALGORITHM=COPY`/,
    );
    assert.equal(typeof first.suggestion, 'string');
    assert.equal(typeof first.example.after, 'string');
  });

  test('ALTER TABLE and CREATE INDEX without ALGORITHM/LOCK', () => {
    const findings = check(
      'ALTER TABLE users ADD INDEX IF NOT EXISTS users_audience_idx (role, created_at);\n' +
        'CREATE INDEX i ON users (email);\n' +
        'ALTER TABLE users ADD INDEX j (a), ALGORITHM=INPLACE, LOCK=NONE;\n' +
        'ALTER TABLE users ADD COLUMN nickname VARCHAR(40), ALGORITHM=INSTANT;\n' +
        'DROP INDEX k ON users;',
    );
    assert.deepEqual(summary(findings), [
      ['migration-mysql-lock-unspecified', 1],
      ['migration-mysql-lock-unspecified', 2],
    ]);
    assert.equal(
      findings[0].example.after,
      'ALTER TABLE users ADD INDEX IF NOT EXISTS users_audience_idx (role, created_at), ALGORITHM=INPLACE, LOCK=NONE',
    );
    assert.equal(findings[1].example.after, 'CREATE INDEX i ON users (email) ALGORITHM=INPLACE LOCK=NONE');
    assert.match(
      findings[0].message,
      /State `ALGORITHM=INPLACE, LOCK=NONE` so MySQL fails instead of silently copying/,
    );
  });

  test('tables created in the same file are silent', () => {
    const findings = check(
      'CREATE TABLE `promo_codes` (id INT PRIMARY KEY, code VARCHAR(20));\n' +
        'ALTER TABLE promo_codes ADD UNIQUE INDEX promo_code_idx (code);\n' +
        'ALTER TABLE PROMO_CODES ADD COLUMN state VARCHAR(10) NOT NULL;\n' +
        'ALTER TABLE promo_codes MODIFY code VARCHAR(40);',
    );
    assert.deepEqual(findings, []);
  });

  test('shared rules: NOT NULL without default, drops and renames', () => {
    const findings = check(
      'ALTER TABLE users ADD COLUMN state VARCHAR(10) NOT NULL, ALGORITHM=INSTANT;\n' +
        "ALTER TABLE users ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'a', ALGORITHM=INSTANT;\n" +
        'ALTER TABLE users DROP COLUMN legacy, ALGORITHM=INSTANT;\n' +
        'ALTER TABLE users RENAME COLUMN a TO b, ALGORITHM=INSTANT;\n' +
        'DROP TABLE old_users;\n' +
        'RENAME TABLE users TO members;',
    );
    assert.deepEqual(summary(findings), [
      ['migration-not-null-without-default', 1],
      ['migration-breaking-drop', 3],
      ['migration-breaking-rename', 4],
      ['migration-breaking-drop', 5],
      ['migration-breaking-rename', 6],
    ]);
    assert.match(findings[0].message, /fail in strict mode/);
    assert.match(findings[3].message, /^`DROP TABLE old_users` breaks app versions/);
  });

  test('data statements and unrecognized statements produce nothing', () => {
    assert.deepEqual(
      check("INSERT INTO reports (name) VALUES ('تقرير المبيعات');\nCREATE PROCEDURE p() BEGIN SELECT 1; END;"),
      [],
    );
  });
});
