'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, describe, test } = require('node:test');
const ts = require('typescript');

const { extractCodeFile } = require('../../lib/performance/migrations/extract-code.cjs');
const {
  extractSqlText,
  prepareDialect,
  sqlFileInTransaction,
} = require('../../lib/performance/migrations/extract-sql.cjs');
const { annotateUnit } = require('../../lib/performance/migrations/operations.cjs');
const { checkMysqlUnit } = require('../../lib/performance/migrations/rules-mysql.cjs');
const { checkPostgresUnit } = require('../../lib/performance/migrations/rules-postgres.cjs');
const { createFileCache } = require('../../lib/performance/site-fix.cjs');
const builders = require('../../lib/performance/site-fixes/migrations.cjs');

function checkSql(sql, { dialect = 'postgres', framework = 'sql', file = 'm.sql' } = {}) {
  const { operations, statementCount } = extractSqlText(sql, { dialect, file });
  annotateUnit(operations, { inTransaction: sqlFileInTransaction(framework, statementCount), dialect });
  const unit = { file, framework, dialect, operations };
  return dialect === 'mysql' ? checkMysqlUnit(unit) : checkPostgresUnit(unit);
}

function checkCode(text, file = 'migration.ts') {
  const { framework, units } = extractCodeFile(text, { file, dialect: 'postgres' });
  return units.flatMap((unit) => {
    annotateUnit(unit.operations, { inTransaction: unit.inTransaction, dialect: 'postgres' });
    return checkPostgresUnit({ file, framework, dialect: 'postgres', operations: unit.operations });
  });
}

// The innermost node starting at or before the reported position, as the site-fix core finds it.
function nodeAt(sourceFile, line, column) {
  const offset = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
  let found;
  (function visit(node) {
    if (node.getStart(sourceFile) <= offset && offset < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  })(sourceFile);
  return found;
}

function applyEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function build(finding, text, load = () => null) {
  const isCode = /\.[cm]?[jt]s$/.test(finding.file);
  const sourceFile = isCode ? ts.createSourceFile(finding.file, text, ts.ScriptTarget.Latest, true) : undefined;
  const node = sourceFile && nodeAt(sourceFile, finding.line, finding.column);
  return builders[finding.ruleId]({ finding, node, sourceFile, text, load });
}

function only(findings, ruleId) {
  const matching = findings.filter((finding) => finding.ruleId === ruleId);
  assert.equal(matching.length, 1, `expected one ${ruleId}, got ${findings.map((finding) => finding.ruleId)}`);
  return matching[0];
}

function fixSql(sql, ruleId, options = {}) {
  const finding = only(checkSql(sql, options), ruleId);
  const result = build(finding, sql);
  assert.ok(result, `${ruleId} produced no fix`);
  return { result, fixed: applyEdits(sql, result.edits) };
}

function fixCode(code, ruleId, file = 'migration.ts') {
  const finding = only(checkCode(code, file), ruleId);
  const result = build(finding, code);
  assert.ok(result, `${ruleId} produced no fix`);
  const fixed = applyEdits(code, result.edits);
  const reparsed = ts.createSourceFile(file, fixed, ts.ScriptTarget.Latest, false);
  assert.equal(reparsed.parseDiagnostics.length, 0, fixed);
  return { result, fixed };
}

const ruleIds = (findings) => findings.map((finding) => finding.ruleId);
const withLockTimeout = (sql) => "SET lock_timeout = '5s';\n" + sql;

function typeormMigration(...queries) {
  return `import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderIndex1700000000000 implements MigrationInterface {
  name = 'AddOrderIndex1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
${queries.map((query) => `    await queryRunner.query(${query});`).join('\n')}
  }

  public async down(queryRunner: QueryRunner): Promise<void> {}
}
`;
}

function temporaryProject(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-migration-fix-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

before(() => prepareDialect('postgres'));

describe('concurrent index builds', () => {
  test('adds CONCURRENTLY in a .sql migration that runs outside a transaction', () => {
    const sql = withLockTimeout('CREATE INDEX orders_store_idx ON orders (store_id);\n');
    const { fixed, result } = fixSql(sql, 'migration-index-not-concurrent');
    assert.equal(fixed, withLockTimeout('CREATE INDEX CONCURRENTLY orders_store_idx ON orders (store_id);\n'));
    assert.match(result.note, /INVALID index/);
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('moves the statement after COMMIT when the file wraps it in BEGIN', () => {
    const sql = withLockTimeout('BEGIN;\nCREATE UNIQUE INDEX users_email_idx ON users (email);\nCOMMIT;\n');
    const { fixed } = fixSql(sql, 'migration-index-not-concurrent');
    assert.equal(
      fixed,
      withLockTimeout('BEGIN;\nCOMMIT;\nCREATE UNIQUE INDEX CONCURRENTLY users_email_idx ON users (email);\n'),
    );
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('gives the index its own Prisma migration when the file has several statements', (context) => {
    const migration = withLockTimeout(
      'ALTER TABLE orders ADD COLUMN note text;\nCREATE INDEX orders_note_idx ON orders (note);\n',
    );
    const root = temporaryProject(context, {
      'prisma/migrations/migration_lock.toml': 'provider = "postgresql"\n',
      'prisma/migrations/20240101000000_init/migration.sql': migration,
    });
    const file = path.join(root, 'prisma/migrations/20240101000000_init/migration.sql');
    const finding = { ...only(checkSql(migration, { framework: 'prisma' }), 'migration-index-not-concurrent'), file };
    const result = build(finding, migration, createFileCache());
    const [edited, created] = result.targets;
    assert.equal(applyEdits(migration, edited.edits), withLockTimeout('ALTER TABLE orders ADD COLUMN note text;\n'));
    assert.equal(created.file, path.join(root, 'prisma/migrations/20240101000001_init_step2/migration.sql'));
    assert.equal(created.create, true);
    assert.equal(created.text, 'CREATE INDEX CONCURRENTLY orders_note_idx ON orders (note);\n');
    assert.match(result.note, /migration of its own/);
  });

  test('has no fix inside a Drizzle migration, whose migrator always opens a transaction', (context) => {
    const sql = 'CREATE INDEX orders_note_idx ON orders (note);\n';
    const root = temporaryProject(context, { 'drizzle/0001_x.sql': sql, 'drizzle/meta/_journal.json': '{}' });
    const finding = { ...only(checkSql(sql, { framework: 'drizzle' }), 'migration-index-not-concurrent') };
    finding.file = path.join(root, 'drizzle/0001_x.sql');
    assert.equal(build(finding, sql, createFileCache()), undefined);
  });

  test('turns off the TypeORM transaction and adds CONCURRENTLY in the query literal', () => {
    const code = typeormMigration('`CREATE INDEX "orders_store_idx" ON "orders" ("store_id")`');
    const { fixed, result } = fixCode(code, 'migration-index-not-concurrent');
    assert.match(fixed, /\n {2}transaction = false;\n {2}name = /);
    assert.match(fixed, /`CREATE INDEX CONCURRENTLY "orders_store_idx" ON "orders" \("store_id"\)`/);
    assert.match(result.note, /migrationsTransactionMode/);
    const remaining = ruleIds(checkCode(fixed));
    assert.ok(
      !remaining.includes('migration-index-not-concurrent') &&
        !remaining.includes('migration-concurrent-in-transaction'),
    );
  });

  test('splits a multi-statement query so the concurrent build gets its own call', () => {
    const code = typeormMigration(
      '`SET lock_timeout = \'5s\'; CREATE INDEX "orders_store_idx" ON "orders" ("store_id"); ALTER TABLE "orders" ADD COLUMN "x" int`',
    );
    const { fixed } = fixCode(code, 'migration-index-not-concurrent');
    assert.match(
      fixed,
      /`SET lock_timeout = '5s'; ALTER TABLE "orders" ADD COLUMN "x" int`\);\n {4}await queryRunner\.query\(`CREATE INDEX CONCURRENTLY "orders_store_idx" ON "orders" \("store_id"\)`\);/,
    );
  });

  test('adds the Knex transaction opt-out', () => {
    const code = `exports.up = async function (knex) {\n  await knex.raw('CREATE INDEX orders_store_idx ON orders (store_id)');\n};\n`;
    const { fixed } = fixCode(code, 'migration-index-not-concurrent', 'migration.js');
    assert.ok(fixed.startsWith('exports.config = { transaction: false };\n\nexports.up'));
    assert.match(fixed, /'CREATE INDEX CONCURRENTLY orders_store_idx ON orders \(store_id\)'/);
  });

  test('passes concurrently to Sequelize addIndex', () => {
    const code = `module.exports = {\n  async up(queryInterface) {\n    await queryInterface.addIndex('orders', ['store_id']);\n  },\n};\n`;
    const { fixed } = fixCode(code, 'migration-index-not-concurrent', 'migration.js');
    assert.match(fixed, /addIndex\('orders', \['store_id'\], \{ concurrently: true \}\)/);
  });

  test('takes a concurrent build out of the TypeORM transaction', () => {
    const code = typeormMigration('`CREATE INDEX CONCURRENTLY "orders_store_idx" ON "orders" ("store_id")`');
    const { fixed } = fixCode(code, 'migration-concurrent-in-transaction');
    assert.match(fixed, /transaction = false;/);
    assert.ok(!ruleIds(checkCode(fixed)).includes('migration-concurrent-in-transaction'));
  });

  test('rebuilds an index with REINDEX CONCURRENTLY, and has no fix for VACUUM FULL', () => {
    const { fixed } = fixSql('REINDEX INDEX orders_store_idx;\n', 'migration-table-rewrite-command');
    assert.equal(fixed, 'REINDEX INDEX CONCURRENTLY orders_store_idx;\n');
    const vacuum = 'VACUUM FULL orders;\n';
    assert.equal(build(only(checkSql(vacuum), 'migration-table-rewrite-command'), vacuum), undefined);
  });
});

describe('column changes', () => {
  test('adds a NOT NULL column without default as nullable', () => {
    const sql = withLockTimeout('ALTER TABLE orders ADD COLUMN note text NOT NULL;\n');
    const { fixed, result } = fixSql(sql, 'migration-not-null-without-default');
    assert.equal(fixed, withLockTimeout('ALTER TABLE orders ADD COLUMN note text;\n'));
    assert.match(result.note, /backfill/);
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('states the implicit MySQL default', () => {
    const sql = 'ALTER TABLE orders ADD COLUMN quantity INT NOT NULL, ALGORITHM=INPLACE, LOCK=NONE;\n';
    const { fixed } = fixSql(sql, 'migration-not-null-without-default', { dialect: 'mysql' });
    assert.equal(
      fixed,
      'ALTER TABLE orders ADD COLUMN quantity INT NOT NULL DEFAULT 0, ALGORITHM=INPLACE, LOCK=NONE;\n',
    );
    assert.deepEqual(ruleIds(checkSql(fixed, { dialect: 'mysql' })), []);
  });

  test('moves a volatile default to SET DEFAULT and drops NOT NULL until the backfill', () => {
    const sql = withLockTimeout('ALTER TABLE orders ADD COLUMN token uuid NOT NULL DEFAULT gen_random_uuid();\n');
    const { fixed, result } = fixSql(sql, 'migration-volatile-default');
    assert.equal(
      fixed,
      withLockTimeout(
        'ALTER TABLE orders ADD COLUMN token uuid;\nALTER TABLE orders ALTER COLUMN token SET DEFAULT gen_random_uuid();\n',
      ),
    );
    assert.match(result.note, /NOT NULL was dropped/);
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('has no volatile-default fix for a serial column', () => {
    const sql = withLockTimeout('ALTER TABLE orders ADD COLUMN position serial;\n');
    assert.equal(build(only(checkSql(sql), 'migration-volatile-default'), sql), undefined);
  });

  test('replaces a rewriting type change with a new column', () => {
    const sql = withLockTimeout('ALTER TABLE orders ALTER COLUMN total TYPE bigint USING total::bigint;\n');
    const { fixed, result } = fixSql(sql, 'migration-column-type-rewrite');
    assert.equal(fixed, withLockTimeout('ALTER TABLE orders ADD COLUMN total_new bigint;\n'));
    assert.match(result.note, /backfill `total_new = total::bigint`/);
  });

  test('proves NOT NULL with a NOT VALID check instead of a scan', () => {
    const sql = withLockTimeout('ALTER TABLE orders ALTER COLUMN note SET NOT NULL;\n');
    const { fixed, result } = fixSql(sql, 'migration-set-not-null-scan');
    assert.equal(
      fixed,
      withLockTimeout('ALTER TABLE orders ADD CONSTRAINT orders_note_not_null CHECK (note IS NOT NULL) NOT VALID;\n'),
    );
    assert.match(result.note, /VALIDATE CONSTRAINT orders_note_not_null/);
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });
});

describe('constraints', () => {
  test('adds a foreign key NOT VALID', () => {
    const sql = withLockTimeout(
      'ALTER TABLE orders ADD CONSTRAINT orders_store_fk FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE;\n',
    );
    const { fixed, result } = fixSql(sql, 'migration-constraint-not-valid');
    assert.match(fixed, /ON DELETE CASCADE NOT VALID;\n$/);
    assert.match(result.note, /VALIDATE CONSTRAINT orders_store_fk/);
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('moves VALIDATE CONSTRAINT out of the transaction that added it', () => {
    const sql = withLockTimeout(
      'BEGIN;\nALTER TABLE orders ADD CONSTRAINT orders_store_fk FOREIGN KEY (store_id) REFERENCES stores (id) NOT VALID;\nALTER TABLE orders VALIDATE CONSTRAINT orders_store_fk;\nCOMMIT;\n',
    );
    const { fixed } = fixSql(sql, 'migration-constraint-not-valid');
    assert.match(fixed, /NOT VALID;\nCOMMIT;\nALTER TABLE orders VALIDATE CONSTRAINT orders_store_fk;\n$/);
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('builds a unique index concurrently, then attaches it', () => {
    const sql = withLockTimeout('ALTER TABLE users ADD UNIQUE (email);\n');
    const { fixed } = fixSql(sql, 'migration-constraint-without-index');
    assert.equal(
      fixed,
      withLockTimeout(
        'CREATE UNIQUE INDEX CONCURRENTLY users_email_key ON users (email);\nALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE USING INDEX users_email_key;\n',
      ),
    );
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });
});

describe('breaking changes', () => {
  test('defers a column drop to a later release', () => {
    const sql = 'ALTER TABLE users DROP COLUMN legacy;\n';
    const { fixed, result } = fixSql(sql, 'migration-breaking-drop');
    assert.equal(
      fixed,
      '-- Deferred to a later release (expand/contract), once no running app version uses it:\n-- ALTER TABLE users DROP COLUMN legacy;\n',
    );
    assert.match(result.note, /warden-reviewed migration-breaking-drop/);
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('keeps the other sub-commands of the statement', () => {
    const sql = withLockTimeout('ALTER TABLE users ADD COLUMN nickname text, DROP COLUMN legacy;\n');
    const { fixed } = fixSql(sql, 'migration-breaking-drop');
    assert.match(
      fixed,
      /ALTER TABLE users ADD COLUMN nickname text;\n-- Deferred .*\n-- ALTER TABLE users DROP COLUMN legacy;\n$/,
    );
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('replaces a TypeORM drop call with a deferral comment', () => {
    const code = typeormMigration('`ALTER TABLE "users" DROP COLUMN "legacy"`');
    const { fixed } = fixCode(code, 'migration-breaking-drop');
    assert.match(
      fixed,
      /\n {4}\/\/ Deferred to a later release.*\n {4}\/\/ ALTER TABLE "users" DROP COLUMN "legacy"\n {2}\}/,
    );
  });

  test('keeps the old table name working through a view', () => {
    const sql = withLockTimeout('ALTER TABLE users RENAME TO accounts;\n');
    const { fixed } = fixSql(sql, 'migration-breaking-rename');
    assert.equal(
      fixed,
      withLockTimeout('ALTER TABLE users RENAME TO accounts;\nCREATE VIEW users AS SELECT * FROM accounts;\n'),
    );
  });

  test('has no fix for a column rename, whose type the finding does not carry', () => {
    const sql = withLockTimeout('ALTER TABLE users RENAME COLUMN name TO full_name;\n');
    assert.equal(build(only(checkSql(sql), 'migration-breaking-rename'), sql), undefined);
  });
});

describe('lock timeouts', () => {
  test('sets lock_timeout before the first locking statement of a .sql file', () => {
    const sql = '-- AddColumn\nALTER TABLE orders ADD COLUMN note text;\n';
    const { fixed } = fixSql(sql, 'migration-missing-lock-timeout');
    assert.equal(fixed, "-- AddColumn\nSET lock_timeout = '5s';\nALTER TABLE orders ADD COLUMN note text;\n");
    assert.deepEqual(ruleIds(checkSql(fixed)), []);
  });

  test('starts the TypeORM up() with SET lock_timeout', () => {
    const code = typeormMigration('`ALTER TABLE "orders" ADD COLUMN "note" text`');
    const { fixed } = fixCode(code, 'migration-missing-lock-timeout');
    assert.match(
      fixed,
      /Promise<void> \{\n {4}await queryRunner\.query\("SET lock_timeout = '5s'"\);\n {4}await queryRunner\.query\(`ALTER/,
    );
    assert.deepEqual(ruleIds(checkCode(fixed)), []);
  });
});

describe('MySQL online DDL', () => {
  test('states ALGORITHM=INPLACE, LOCK=NONE on an ALTER TABLE', () => {
    const sql = 'ALTER TABLE orders ADD COLUMN note TEXT;\n';
    const { fixed } = fixSql(sql, 'migration-mysql-lock-unspecified', { dialect: 'mysql' });
    assert.equal(fixed, 'ALTER TABLE orders ADD COLUMN note TEXT, ALGORITHM=INPLACE, LOCK=NONE;\n');
    assert.deepEqual(ruleIds(checkSql(fixed, { dialect: 'mysql' })), []);
  });

  test('states the options on CREATE INDEX with spaces', () => {
    const sql = 'CREATE INDEX orders_note_idx ON orders (note);\n';
    const { fixed } = fixSql(sql, 'migration-mysql-lock-unspecified', { dialect: 'mysql' });
    assert.equal(fixed, 'CREATE INDEX orders_note_idx ON orders (note) ALGORITHM=INPLACE LOCK=NONE;\n');
    assert.deepEqual(ruleIds(checkSql(fixed, { dialect: 'mysql' })), []);
  });

  test('replaces ALGORITHM=COPY so MySQL refuses instead of copying', () => {
    const sql = 'ALTER TABLE orders ALGORITHM=COPY, ADD COLUMN note TEXT;\n';
    const { fixed, result } = fixSql(sql, 'migration-mysql-table-copy', { dialect: 'mysql' });
    assert.equal(fixed, 'ALTER TABLE orders ALGORITHM=INPLACE, ADD COLUMN note TEXT, LOCK=NONE;\n');
    assert.match(result.note, /gh-ost/);
    assert.deepEqual(ruleIds(checkSql(fixed, { dialect: 'mysql' })), []);
  });
});
