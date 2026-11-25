import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projects, projectFiles, indexFindings, nativeAvailable, runOnNativeEngine } from './index-rules-fixtures.js';
import type { OrmName } from '../types/orm-name.js';
import { findSourceFile } from '../types/source-files.js';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.js';
import { checkSchemaFile } from '../../lib/performance/schema/prisma-schema.js';
import { drizzle } from './fixtures/schema/orm-stubs.js';
import { withProgram } from './helpers.js';
import { analyzeFile } from '../../lib/performance/analyze.js';

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';
// schema.prisma checks involve no TypeScript engine; loading them first would bind the rules to the
// JS compiler.
const prismaOptions = { skip: onNativeEngine };

test('Prisma: an unindexed relation scalar on PostgreSQL is reported on its schema line', prismaOptions, () => {
  const root = path.join(import.meta.dirname, 'fixtures/schema/prisma-shop');
  const findings = checkSchemaFile(root);
  assert.deepEqual(
    findings.map(({ file, line, column, ruleId }) => ({ file, line, column, ruleId })),
    [
      {
        file: 'test/performance/fixtures/schema/prisma-shop/prisma/schema.prisma',
        line: 54,
        column: 3,
        ruleId: 'index-missing-foreign-key',
      },
    ],
  );
  assert.equal(
    findings[0].message,
    '`Order.customerId` references `User` and no index starts with it, so deleting or updating a `User` row scans ' +
      '`orders` to check the reference, and joins from `User` cannot use an index. Add `@@index([customerId], map: "orders_customer_id_idx")` to model ' +
      '`Order` (test/performance/fixtures/schema/prisma-shop/prisma/schema.prisma:50); on a live database build it with ' +
      '`CREATE INDEX CONCURRENTLY "orders_customer_id_idx" ON "orders" ("customerId");`. PostgreSQL does not create ' +
      'this index for a foreign key automatically. Table size is unknown; pass `--schema` to gate this rule by row count.',
  );
  assert.equal(findings[0].suggestion, '@@index([customerId], map: "orders_customer_id_idx")');
});

test(
  'Prisma: MySQL indexes foreign keys itself, and composite references check only their first column',
  prismaOptions,
  () => {
    const models = `
model Account {
  tenantId String
  id       String
  @@id([tenantId, id])
}
model Invoice {
  id        String @id
  tenantId  String
  accountId String
  account   Account @relation(fields: [tenantId, accountId], references: [tenantId, id])
  @@index([tenantId, accountId])
}
model Payment {
  id        String @id
  accountTenant String
  accountId String
  account   Account @relation(fields: [accountTenant, accountId], references: [tenantId, id])
}`;
    const findingsFor = (provider: string) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-check-fk-'));
      try {
        fs.mkdirSync(path.join(root, 'prisma'));
        fs.writeFileSync(path.join(root, 'package.json'), '{}');
        const datasource = `datasource db {
  provider = "${provider}"
}
`;
        fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'), datasource + models);
        return checkSchemaFile(root).map(({ line, ruleId }) => [line, ruleId]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
    assert.deepEqual(findingsFor('postgresql'), [[19, 'index-missing-foreign-key']]);
    assert.deepEqual(findingsFor('mysql'), []);
  },
);

test('Drizzle: references() on pgTable columns without an index, MySQL tables silent', () => {
  const source = `import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core';
import { mysqlTable, int } from 'drizzle-orm/mysql-core';
export const users = pgTable('users', { id: uuid().primaryKey(), name: text() });
export const cases = pgTable(
  'cases',
  {
    id: uuid().primaryKey(),
    ownerId: uuid('owner_id').references(() => users.id),
    reviewerId: uuid('reviewer_id').references(() => users.id),
    editorId: uuid('editor_id').unique().references(() => users.id),
  },
  (table) => [index('cases_owner_id_idx').on(table.ownerId)],
);
export const carts = mysqlTable('carts', { id: int().primaryKey(), userId: int('user_id').references(() => users.id) });
`;
  // The table is declared in main.ts itself, so the drizzle stubs sit beside it.
  const findings = indexFindings(source, drizzle);
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [[9, 'index-missing-foreign-key']],
  );
  assert.match(
    findings[0].message,
    /^`cases.reviewerId` references `users` and no index starts with it, .*Add `index\('cases_reviewer_id_idx'\)\.on\(table\.reviewerId\)` to the indexes of table `cases` \(test\/performance\/virtual-project\/main\.ts:4\)/,
  );
});

// Decorated entities read their dialect from the fixture's package.json, so the entity file itself
// is analyzed.
function analyzeFixtureFile(orm: OrmName, name: string, contents: string) {
  const target = path.join(import.meta.dirname, 'virtual-project', projects[orm], name);
  return withProgram('', projectFiles(orm, { [name]: contents }), (program: ProgramAdapter) =>
    analyzeFile(
      program,
      findSourceFile(program, (file) => path.resolve(file.fileName) === target),
    ),
  )
    .filter((finding: Finding) => finding.ruleId.startsWith('index-'))
    .map(({ line, ruleId, message }) => ({ line, ruleId, message }));
}

test('TypeORM: @ManyToOne with an explicit @JoinColumn name', { skip: onNativeEngine }, () => {
  const findings = analyzeFixtureFile(
    'typeorm',
    'entities.ts',
    `import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
@Entity('schools')
export class School {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
}
@Entity('classes')
export class SchoolClass {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @ManyToOne(() => School)
  @JoinColumn({ name: 'school_id' })
  school!: School;
  @Index()
  @ManyToOne(() => School)
  @JoinColumn({ name: 'campus_id' })
  campus!: School;
  @ManyToOne(() => School)
  annex!: School;
}
`,
  );
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [[13, 'index-missing-foreign-key']],
  );
  assert.match(findings[0].message, /^`SchoolClass.school` references `School` and no index starts with it/);
  assert.match(
    findings[0].message,
    /Add `@Index\('classes_school_id_idx'\)` to the `school` property of entity `SchoolClass`/,
  );
  assert.match(findings[0].message, /ON "classes" \("school_id"\)/);
});

test('Sequelize: @ForeignKey columns on a PostgreSQL project', { skip: onNativeEngine }, () => {
  const findings = analyzeFixtureFile(
    'sequelize',
    'models.ts',
    `import { Table, Column, Model, DataType, PrimaryKey, ForeignKey, Index } from 'sequelize-typescript';
@Table({ tableName: 'Stores' })
export class Store extends Model<Store> {
  @PrimaryKey
  @Column(DataType.UUID)
  id!: string;
}
@Table({ tableName: 'Sales' })
export class Sale extends Model<Sale> {
  @ForeignKey(() => Store)
  @Column(DataType.UUID)
  storeId!: string;
  @Index
  @ForeignKey(() => Store)
  @Column(DataType.UUID)
  branchId!: string;
}
`,
  );
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [[12, 'index-missing-foreign-key']],
  );
  assert.match(
    findings[0].message,
    /Add `\{ name: 'sales_store_id_idx', fields: \['storeId'\] \}` to the `indexes` of model `Sale`/,
  );
});

test('the same foreign-key findings on the TypeScript 7 engine', { skip: onNativeEngine || !nativeAvailable() }, () => {
  const result = runOnNativeEngine(import.meta.filename);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]\d*/);
});
