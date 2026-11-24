import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { extractCodeFile } from '../../lib/performance/migrations/extract-code.cjs';
import { prepareDialect } from '../../lib/performance/migrations/extract-sql.cjs';
import type { MigrationOperation } from '../../lib/performance/types/migration-operations.cjs';

const extract = (text: string, file = 'migration.ts') => extractCodeFile(text, { file, dialect: 'postgres' });
const summary = (operation: MigrationOperation) => [operation.kind, operation.table, operation.line, operation.column];

describe('TypeORM extraction', () => {
  test('local bindings shadow a same-name outer migration helper or SQL constant', () => {
    for (const [parameters, setup] of [
      ['queryRunner, sql', ''],
      ['queryRunner', 'let sql = getSql();'],
      ['queryRunner, values', 'const {sql} = values;'],
    ]) {
      const source = `const sql = 'DROP TABLE users'; export async function up(${parameters}) { ${setup} await queryRunner.query(sql); }`;
      assert.deepEqual(extract(source).units[0].operations, []);
    }
    const source =
      "function migrate(queryRunner) { return queryRunner.query('DROP TABLE users'); } export async function up(queryRunner, migrate) { await migrate(queryRunner); }";
    assert.deepEqual(extract(source).units[0].operations, []);
  });
  before(() => prepareDialect('postgres'));

  test('reads queryRunner.query literals in up() only, with exact positions', () => {
    const result = extract(
      [
        "import { MigrationInterface, QueryRunner } from 'typeorm';",
        'export class AddIndex1 implements MigrationInterface {',
        '  public async up(queryRunner: QueryRunner): Promise<void> {',
        '    await queryRunner.query(`CREATE TABLE "fresh" (id int)`);',
        '    await queryRunner.query(`',
        '      CREATE INDEX "idx_orders" ON "orders" ("customer_id")`);',
        '    await queryRunner.query(\'DROP TABLE "legacy"\');',
        '  }',
        '  public async down(queryRunner: QueryRunner): Promise<void> {',
        '    await queryRunner.query(`DROP INDEX "idx_orders"`);',
        '  }',
        '}',
      ].join('\n'),
    );
    assert.equal(result.framework, 'typeorm');
    assert.equal(result.units.length, 1);
    assert.equal(result.units[0].inTransaction, true);
    assert.deepEqual(result.units[0].operations.map(summary), [
      ['create-table', 'fresh', 4, 30],
      ['create-index', 'orders', 6, 7],
      ['drop-table', 'legacy', 7, 30],
    ]);
  });

  test('template holes become dynamic placeholders and keep later positions exact', () => {
    const [unit] = extract(
      [
        'export class Loop implements MigrationInterface {',
        '  transaction = false;',
        '  async up(queryRunner) {',
        '    for (const column of this.columns) {',
        '      await queryRunner.query(`ALTER TABLE "admissions" ALTER COLUMN "${column}" DROP NOT NULL`);',
        '    }',
        '    await queryRunner.query(`ALTER TABLE "${name}" ADD COLUMN a int; CREATE INDEX i ON t (a)`);',
        '  }',
        '}',
      ].join('\n'),
    ).units;
    assert.equal(unit.inTransaction, false);
    const [dropNotNull, addColumn, index] = unit.operations;
    assert.equal(dropNotNull.dynamic, true);
    assert.equal(dropNotNull.columnName, '__bpc_dynamic_0');
    assert.equal(addColumn.table, '__bpc_dynamic_0');
    assert.deepEqual(summary(index), ['create-index', 't', 7, 70]);
    assert.equal(index.dynamic, false);
  });

  test('resolves const SQL and falls back to the literal start for escaped strings', () => {
    const [unit] = extract(
      [
        'const indexSql = `CREATE INDEX i ON orders (a)`;',
        'export class C implements MigrationInterface {',
        '  async up(queryRunner: QueryRunner) {',
        '    await queryRunner.query(indexSql);',
        "    await queryRunner.query('ALTER TABLE \\'x\\' ; DROP TABLE t');",
        '  }',
        '}',
      ].join('\n'),
    ).units;
    assert.deepEqual(summary(unit.operations[0]), ['create-index', 'orders', 1, 19]);
    const dropTable = unit.operations.find((operation) => operation.kind === 'drop-table');
    assert.ok(dropTable);
    assert.deepEqual([dropTable.line, dropTable.column], [5, 30]);
  });

  test('maps schema-builder calls to operations', () => {
    const [unit] = extract(
      [
        'export class B implements MigrationInterface {',
        '  async up(queryRunner: QueryRunner) {',
        "    await queryRunner.createTable(new Table({ name: 'fresh', columns: [] }));",
        "    await queryRunner.createIndex('orders', new TableIndex({ columnNames: ['a'] }));",
        "    await queryRunner.addColumn('orders', new TableColumn({ name: 'state', type: 'varchar' }));",
        "    await queryRunner.addColumn('orders', new TableColumn({ name: 'note', type: 'text', isNullable: true }));",
        "    await queryRunner.addColumn('orders', new TableColumn({ name: 'id2', type: 'uuid', default: 'gen_random_uuid()' }));",
        "    await queryRunner.dropColumn('orders', 'legacy');",
        "    await queryRunner.renameColumn('orders', 'a', 'b');",
        "    await queryRunner.createForeignKey('orders', new TableForeignKey({}));",
        '  }',
        '}',
      ].join('\n'),
    ).units;
    const operations = unit.operations;
    assert.deepEqual(
      operations.map((operation) => operation.kind),
      [
        'create-table',
        'create-index',
        'add-column',
        'add-column',
        'add-column',
        'drop-column',
        'rename-column',
        'add-constraint',
      ],
    );
    assert.equal(operations[0].table, 'fresh');
    assert.equal(operations[2].notNull, true);
    assert.equal(operations[2].hasDefault, false);
    assert.equal(operations[3].notNull, false);
    const defaultExpression = operations[4].defaultExpression;
    assert.ok(defaultExpression && 'FuncCall' in defaultExpression);
    const [functionName] = defaultExpression.FuncCall.funcname ?? [];
    assert.ok(functionName && 'String' in functionName);
    assert.equal(functionName.String.sval, 'gen_random_uuid');
    assert.equal(operations[6].newName, 'b');
    assert.equal(operations[7].constraintType, 'foreign');
  });
});

describe('Knex extraction', () => {
  before(() => prepareDialect('postgres'));

  test('reads alterTable builders, schema calls and raw SQL; config disables the transaction', () => {
    const result = extract(
      [
        'exports.config = { transaction: false };',
        'exports.up = async function (knex) {',
        "  await knex.schema.createTable('fresh', (t) => { t.increments('id'); t.index('id'); });",
        "  await knex.schema.alterTable('orders', (table) => {",
        "    table.string('state').notNullable();",
        "    table.string('note').notNullable().defaultTo('x');",
        "    table.integer('total').notNullable().alter();",
        "    table.index(['customer_id']);",
        "    table.unique(['code']);",
        "    table.dropColumn('legacy');",
        "    table.renameColumn('a', 'b');",
        '  });',
        "  await knex.raw('CREATE INDEX CONCURRENTLY i ON orders (a)');",
        "  await knex.schema.dropTable('old');",
        '};',
        'exports.down = async function (knex) {',
        "  await knex.schema.dropTable('fresh');",
        '};',
      ].join('\n'),
      'migration.js',
    );
    assert.equal(result.framework, 'knex');
    const [unit] = result.units;
    assert.equal(unit.inTransaction, false);
    assert.deepEqual(
      unit.operations.map((operation) => [operation.kind, operation.table, operation.columnName]),
      [
        ['create-table', 'fresh', null],
        ['add-column', 'orders', 'state'],
        ['add-column', 'orders', 'note'],
        ['alter-column-type', 'orders', 'total'],
        ['set-not-null', 'orders', 'total'],
        ['create-index', 'orders', null],
        ['add-constraint', 'orders', null],
        ['drop-column', 'orders', 'legacy'],
        ['rename-column', 'orders', 'a'],
        ['create-index', 'orders', null],
        ['drop-table', 'old', null],
      ],
    );
    assert.equal(unit.operations[1].notNull, true);
    assert.equal(unit.operations[1].hasDefault, false);
    assert.equal(unit.operations[2].hasDefault, true);
    assert.equal(unit.operations[9].concurrent, true);
  });

  test('Knex wraps migrations in a transaction by default', () => {
    const [unit] = extract("exports.up = (knex) => knex.raw('CREATE INDEX i ON t (a)');", 'migration.js').units;
    assert.equal(unit.inTransaction, true);
  });
});

describe('Sequelize extraction', () => {
  before(() => prepareDialect('postgres'));

  test('reads queryInterface builders and marks explicit transactions', () => {
    const result = extract(
      [
        "'use strict';",
        'module.exports = {',
        '  async up(queryInterface, Sequelize) {',
        "    await queryInterface.addColumn('Reports', 'image', { type: Sequelize.STRING, allowNull: true });",
        "    await queryInterface.addColumn('Reports', 'code', { type: Sequelize.STRING, allowNull: false });",
        "    await queryInterface.addColumn('Reports', 'uid', { type: Sequelize.UUID, allowNull: false, defaultValue: Sequelize.UUIDV4 });",
        "    await queryInterface.addIndex('Reports', ['code'], { concurrently: true });",
        "    await queryInterface.addIndex('Reports', ['image']);",
        '    await queryInterface.sequelize.transaction(async (transaction) => {',
        "      await queryInterface.removeColumn('Reports', 'old', { transaction });",
        '      await queryInterface.sequelize.query(\'ALTER TABLE "Reports" RENAME COLUMN a TO b\', { transaction });',
        '    });',
        "    await queryInterface.addConstraint('Reports', { type: 'unique', fields: ['code'] });",
        "    await queryInterface.changeColumn('Reports', 'total', { type: Sequelize.INTEGER, allowNull: false });",
        "    await queryInterface.bulkInsert('Reports', [{ name: 'تقرير' }]);",
        '  },',
        '  async down(queryInterface) {',
        "    await queryInterface.dropTable('Reports');",
        '  },',
        '};',
      ].join('\n'),
      'migration.cjs',
    );
    assert.equal(result.framework, 'sequelize');
    const [unit] = result.units;
    assert.equal(unit.inTransaction, false);
    assert.deepEqual(
      unit.operations.map((operation) => [operation.kind, operation.columnName, operation.explicitTransaction]),
      [
        ['add-column', 'image', false],
        ['add-column', 'code', false],
        ['add-column', 'uid', false],
        ['create-index', null, false],
        ['create-index', null, false],
        ['drop-column', 'old', true],
        ['rename-column', 'a', true],
        ['add-constraint', null, false],
        ['alter-column-type', 'total', false],
        ['set-not-null', 'total', false],
        ['data', null, false],
      ],
    );
    const [nullable, required, clientDefault, concurrent, plain] = unit.operations;
    assert.equal(nullable.notNull, false);
    assert.equal(required.notNull, true);
    assert.equal(clientDefault.hasDefault, false);
    assert.equal(concurrent.concurrent, true);
    assert.equal(plain.concurrent, false);
    assert.equal(unit.operations[7].constraintType, 'unique');
  });
});
