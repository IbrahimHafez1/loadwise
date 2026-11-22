'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, describe, test } = require('node:test');

const { migrationIndexes } = require('../../lib/performance/schema/project-indexes.cjs');
const { extractCodeFile } = require('../../lib/performance/migrations/extract-code.cjs');
const { prepareDialect } = require('../../lib/performance/migrations/extract-sql.cjs');

// A throwaway project whose migrations folder holds the given files.
function projectWith(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round-f-f2-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, 'migrations', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return migrationIndexes(root);
}

const indexesOf = (tables, table) =>
  tables.get(table)?.indexes.map((index) => [index.keys.map((key) => key.column).join(','), index.unique]) ?? [];

describe('CREATE TABLE constraints count as indexes', () => {
  test('table-level and column-level UNIQUE and PRIMARY KEY', (context) => {
    const tables = projectWith(context, {
      '001-Init.ts': `export class Init {
  async up(queryRunner) {
    await queryRunner.query(\`
      CREATE TABLE "form_versions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "school_id" uuid NOT NULL,
        "version_number" integer NOT NULL,
        "status" text NOT NULL DEFAULT 'unique' CHECK ("status" IN ('unique', 'draft')),
        "slug" text UNIQUE,
        CONSTRAINT "PK_form_versions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_form_versions_school" FOREIGN KEY ("school_id") REFERENCES "schools"("id"),
        CONSTRAINT "UQ_form_versions_school_version" UNIQUE ("school_id", "version_number")
      )
    \`);
    await queryRunner.query('CREATE TABLE IF NOT EXISTS tags (id serial PRIMARY KEY, name text)');
  }
}`,
    });
    assert.deepEqual(indexesOf(tables, 'form_versions'), [
      ['slug', true],
      ['id', true],
      ['school_id,version_number', true],
    ]);
    assert.deepEqual(indexesOf(tables, 'tags'), [['id', true]]);
  });

  test('a later DROP CONSTRAINT removes a named table constraint', (context) => {
    const tables = projectWith(context, {
      '001_init.sql': 'CREATE TABLE orders (id int, code text, CONSTRAINT orders_code_key UNIQUE (code));',
      '002_drop.sql': 'ALTER TABLE orders DROP CONSTRAINT orders_code_key;',
    });
    assert.deepEqual(indexesOf(tables, 'orders'), []);
  });

  test('a DROP INDEX on a loop variable drops the names listed in the file', (context) => {
    const tables = projectWith(context, {
      '001_init.sql': [
        'CREATE INDEX "IDX_versions_school_id" ON versions (school_id);',
        'CREATE INDEX "IDX_versions_status" ON versions (status);',
      ].join('\n'),
      '002-DropRedundant.ts': `const REDUNDANT = [{ indexName: 'IDX_versions_school_id', tableName: 'versions' }] as const;
export class DropRedundant {
  async up(queryRunner) {
    for (const { indexName } of REDUNDANT) {
      await queryRunner.query(\`DROP INDEX CONCURRENTLY IF EXISTS "\${indexName}"\`);
    }
  }
}`,
    });
    assert.deepEqual(indexesOf(tables, 'versions'), [['status', false]]);
  });
});

describe('n8n migration DSL and TypeORM createIndex', () => {
  test('createIndex, withIndexOn and withUniqueConstraintOn register indexes', (context) => {
    const tables = projectWith(context, {
      '1700000000001-Init.ts': `export class Init {
  async up({ schemaBuilder: { createTable, createIndex, column } }) {
    await createTable('chat_hub_tools')
      .withColumns(column('id').uuid.primary, column('ownerId').uuid.notNull, column('name').varchar(64))
      .withIndexOn(['ownerId', 'name'], true)
      .withIndexOn('name')
      .withUniqueConstraintOn('id').withTimestamps;
    await createIndex('shared_workflow', ['projectId']);
    await createIndex('user', ['apiKey'], true);
    await createIndex('execution_entity', ['waitTill'], false, 'IDX_wait', '"waitTill" IS NOT NULL');
  }
  async down({ schemaBuilder: { dropIndex } }) {
    await dropIndex('shared_workflow', ['projectId']);
  }
}`,
      '1700000000002-Typeorm.ts': `export class Typeorm {
  async up(queryRunner) {
    await queryRunner.createIndex('orders', new TableIndex({ name: 'IDX_orders_customer', columnNames: ['customerId'], isUnique: true }));
  }
}`,
    });
    assert.deepEqual(indexesOf(tables, 'chat_hub_tools'), [
      ['ownerid,name', true],
      ['name', false],
      ['id', true],
    ]);
    assert.deepEqual(indexesOf(tables, 'shared_workflow'), [['projectid', false]]);
    assert.deepEqual(indexesOf(tables, 'user'), [['apikey', true]]);
    assert.deepEqual(indexesOf(tables, 'execution_entity'), []);
    assert.equal(tables.get('execution_entity').mentioned.has('waittill'), true);
    assert.deepEqual(indexesOf(tables, 'orders'), [['customerid', true]]);
  });

  test('dropIndex by columns or by name removes the index', (context) => {
    const tables = projectWith(context, {
      '1700000000001-Init.ts': `export class Init {
  async up({ schemaBuilder: { createIndex } }) {
    await createIndex('execution_entity', ['stoppedAt']);
    await createIndex('execution_entity', ['deletedAt']);
    await createIndex('execution_entity', ['status'], false, 'IDX_status');
  }
}`,
      '1700000000002-Drop.ts': `export class Drop {
  async up({ schemaBuilder: { dropIndex } }) {
    await dropIndex('execution_entity', ['stoppedAt']);
    await dropIndex('execution_entity', ['status'], { customIndexName: 'IDX_status' });
  }
}`,
    });
    assert.deepEqual(indexesOf(tables, 'execution_entity'), [['deletedat', false]]);
  });
});

describe('MikroORM migrations', () => {
  before(() => prepareDialect('postgres'));
  const extract = (text) => extractCodeFile(text, { file: 'Migration1.ts', dialect: 'postgres' });

  test('this.addSql runs raw SQL inside the migration transaction', () => {
    const result = extract(`import { Migration } from '@medusajs/framework/mikro-orm/migrations';
export class Migration1 extends Migration {
  override async up(): Promise<void> {
    this.addSql('ALTER TABLE "order" ADD CONSTRAINT "order_address_fk" FOREIGN KEY ("address_id") REFERENCES "order_address" ("id");');
    this.addSql('create index if not exists "IDX_order_status" on "order" ("status");');
  }
  override async down(): Promise<void> {
    this.addSql('drop index if exists "IDX_order_status";');
  }
}`);
    assert.equal(result.framework, 'mikro-orm');
    assert.equal(result.units.length, 1);
    assert.equal(result.units[0].inTransaction, true);
    assert.deepEqual(
      result.units[0].operations.map((operation) => [operation.kind, operation.table]),
      [
        ['add-constraint', 'order'],
        ['create-index', 'order'],
      ],
    );
  });

  test('isTransactional() returning false runs the migration outside a transaction', () => {
    const result = extract(`import { Migration } from '@mikro-orm/migrations';
export class Migration2 extends Migration {
  isTransactional(): boolean {
    return false;
  }
  async up(): Promise<void> {
    this.addSql('create index concurrently "IDX_order_status" on "order" ("status");');
  }
}`);
    assert.equal(result.units[0].inTransaction, false);
    assert.equal(result.units[0].operations.length, 1);
  });
});
