// Regressions from reviewing index-redundant-prefix on real projects: partial TypeORM indexes, the
// spelling and form of the suggested DROP, dropped and renamed tables, labels that tell indexes
// apart, inherited indexes and the whole-line Drizzle removal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectFiles } from './index-rules-fixtures.cjs';
import { scanWithFixes, requireFix } from './site-fix-helpers.cjs';
import { applyChangesToText } from '../../editor/apply-fix.cjs';
import { checkRedundantSchemaIndexes } from '../../lib/performance/redundant-indexes.cjs';
import { drizzle as drizzleStubs } from './fixtures/schema/orm-stubs.cjs';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.cjs';
import type { FileMap } from '../types/project-files.cjs';
import { fileOf } from '../types/finding-fix.cjs';
import type { OrmName } from '../types/orm-name.cjs';
import type * as Helpers from './helpers.cjs';
import type * as Analyze from '../../lib/performance/analyze.cjs';

const ruleId = 'index-redundant-prefix';
// The source checks build a TypeScript 6 program; the TypeScript 7 run is covered by
// index-redundant-prefix.
const sourceOptions = { skip: process.env.PERF_CHECK_TEST_NATIVE === '1' };

// Redundant-index findings of every project source file, as { file, line, message, suggestion }.
function sourceFindings(orm: OrmName, files: FileMap) {
  const { withProgram }: typeof Helpers = require('./helpers.cjs');
  const { analyzeFile }: typeof Analyze = require('../../lib/performance/analyze.cjs');
  const findings = withProgram('', projectFiles(orm, files), (program: ProgramAdapter) => {
    assert.ok(program.getSourceFiles, 'the program should list its source files');
    return program
      .getSourceFiles()
      .filter((file) => !file.isDeclarationFile && !file.fileName.includes('node_modules'))
      .filter((file) => Object.keys(files).some((name) => path.resolve(file.fileName).endsWith(path.normalize(name))))
      .flatMap((file) => analyzeFile(program, file));
  });
  return findings
    .filter((finding: Finding) => finding.ruleId === ruleId)
    .map((finding) => ({
      file: path.basename(fileOf(finding)),
      line: finding.line,
      message: finding.message,
      suggestion: finding.suggestion,
    }));
}

function withProject<Result>(
  files: FileMap,
  run: (root: string) => Result,
  dependencies: Record<string, string> = { pg: '8.0.0' },
): Result {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-redundant-review-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies }));
    for (const [name, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), contents);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function schemaFindings(files: FileMap, dialect = 'postgres') {
  const dependencies: Record<string, string> = dialect === 'mysql' ? { mysql2: '3.0.0' } : { pg: '8.0.0' };
  return withProject(
    files,
    (root: string) =>
      checkRedundantSchemaIndexes(root, { dialect }).map((finding) => ({
        file: path.basename(fileOf(finding)),
        line: finding.line,
        message: finding.message,
        suggestion: finding.suggestion,
      })),
    dependencies,
  );
}

test('TypeORM: a `where` built from a template with substitutions keeps the index partial', sourceOptions, () => {
  const source = `import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
enum Status { Completed = 'completed' }
@Entity('appointments')
@Index('IDX_clinic_patient', ['clinicId', 'patientId'])
@Index('IDX_completed_visits', ['clinicId', 'patientId', 'scheduledAt'], {
  where: \`"status" = '\${Status.Completed}' AND "deletedAt" IS NULL\`,
})
export class Appointment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Column()
  clinicId!: string;
  @Column()
  patientId!: string;
  @Index('IDX_scheduled_at')
  @Column()
  scheduledAt!: Date;
  @Index('IDX_scheduled_due', { where: \`"status" = '\${Status.Completed}'\` })
  @Column()
  dueAt!: Date;
}
`;
  assert.deepEqual(sourceFindings('typeorm', { 'src/appointment.ts': source }), []);
});

test('migrations: names and columns keep their quoted spelling and PostgreSQL drops CONCURRENTLY', () => {
  const [finding] = schemaFindings({
    'migrations/001_leads.ts': `export class Leads {
  async up(queryRunner) {
    await queryRunner.query(\`CREATE TABLE "outreach_leads" ("id" uuid PRIMARY KEY, "status" text, "createdAt" timestamptz)\`);
    await queryRunner.query(\`CREATE INDEX "IDX_outreach_leads_status" ON "outreach_leads" ("status")\`);
    await queryRunner.query(\`CREATE INDEX "IDX_outreach_leads_status_created" ON "outreach_leads" ("status", "createdAt")\`);
  }
}
`,
  });
  assert.equal(
    finding.message,
    'Index `IDX_outreach_leads_status` (status) on `outreach_leads` is a leading prefix of index ' +
      '`IDX_outreach_leads_status_created` (status, createdAt), so it serves no lookup the longer index cannot and ' +
      'only adds write cost and memory. Drop the shorter index.',
  );
  assert.equal(finding.suggestion, 'DROP INDEX CONCURRENTLY "IDX_outreach_leads_status";');
});

test('migrations: an unquoted name is shown as PostgreSQL folds it, MySQL drops through ALTER TABLE', () => {
  const files = {
    'migrations/001.sql': [
      'CREATE INDEX Orders_Tenant_Idx ON Orders (TenantId);',
      'CREATE INDEX orders_tenant_status_idx ON Orders (TenantId, Status);',
    ].join('\n'),
  };
  assert.equal(schemaFindings(files)[0].suggestion, 'DROP INDEX CONCURRENTLY "orders_tenant_idx";');
  assert.equal(schemaFindings(files, 'mysql')[0].suggestion, 'ALTER TABLE `Orders` DROP INDEX `orders_tenant_idx`;');
});

test('migrations: a redundant unique constraint is dropped as a constraint', () => {
  const [finding] = schemaFindings({
    'migrations/001.sql': [
      'CREATE TABLE members (id int PRIMARY KEY, tenant_id int, user_id int, CONSTRAINT members_pair UNIQUE (tenant_id, user_id));',
      'CREATE UNIQUE INDEX members_pair_idx ON members (tenant_id, user_id);',
    ].join('\n'),
  });
  assert.match(
    finding.message,
    /^Unique index `members_pair_idx` \(tenant_id, user_id\) on `members` duplicates unique constraint `members_pair`/,
  );
  assert.equal(finding.suggestion, 'DROP INDEX CONCURRENTLY "members_pair_idx";');
});

test('migrations: indexes of a table a later migration drops are not reported', () => {
  const create = (table: string) =>
    `CREATE INDEX ${table}_a_idx ON ${table} (a);\nCREATE INDEX ${table}_ab_idx ON ${table} (a, b);\n`;
  const findings = schemaFindings({
    'migrations/001_init.sql': ['orders', 'items', 'carts', 'tags', 'kept'].map(create).join(''),
    'migrations/002_drop.sql': ['DROP TABLE IF EXISTS "public"."orders", items CASCADE;', 'DROP TABLE `carts`;'].join(
      '\n',
    ),
    'migrations/003_drop.ts': "export async function up(knex) { await knex.schema.dropTableIfExists('tags'); }\n",
  });
  assert.deepEqual(
    findings.map(({ file, line }) => [file, line]),
    [['001_init.sql', 9]],
  );
});

test('migrations: a renamed table keeps its indexes under the new name', () => {
  const findings = schemaFindings({
    'migrations/001_init.sql': 'CREATE INDEX legacy_a_idx ON legacy_orders (a);\n',
    'migrations/002_rename.sql': 'ALTER TABLE IF EXISTS legacy_orders RENAME TO orders;\n',
    'migrations/003_index.sql': 'CREATE INDEX orders_ab_idx ON orders (a, b);\n',
  });
  assert.deepEqual(
    findings.map(({ file, line }) => [file, line]),
    [['001_init.sql', 1]],
  );
  assert.match(findings[0].message, /on `orders`/);
});

test('migrations: a dropped column takes its indexes with it', () => {
  const findings = schemaFindings({
    'migrations/001_init.sql': [
      'CREATE INDEX orders_a_idx ON orders (a);',
      'CREATE INDEX orders_ab_idx ON orders (a, b);',
      'CREATE INDEX orders_c_idx ON orders (c);',
      'CREATE INDEX orders_cd_idx ON orders (c, d);',
    ].join('\n'),
    'migrations/002_drop.sql': 'ALTER TABLE orders DROP COLUMN IF EXISTS a;\n',
  });
  assert.deepEqual(
    findings.map(({ file, line }) => [file, line]),
    [['001_init.sql', 3]],
  );
});

test('migrations: a knex dropColumn takes its indexes with it', () => {
  const findings = schemaFindings({
    'migrations/001_init.sql':
      'CREATE INDEX orders_a_idx ON orders (a);\nCREATE INDEX orders_ab_idx ON orders (a, b);\n',
    'migrations/002_drop.js':
      "exports.up = (knex) => knex.schema.alterTable('orders', (table) => { table.dropColumn('a'); });\n",
  });
  assert.deepEqual(findings, []);
});

test('migrations: TypeORM queryRunner.dropColumn takes its indexes with it', () => {
  const findings = schemaFindings({
    'migrations/001_init.sql': [
      'CREATE INDEX orders_a_idx ON orders (a);',
      'CREATE INDEX orders_ab_idx ON orders (a, b);',
      'CREATE INDEX orders_c_idx ON orders (c);',
      'CREATE INDEX orders_cd_idx ON orders (c, d);',
      'CREATE INDEX orders_e_idx ON orders (e);',
      'CREATE INDEX orders_ef_idx ON orders (e, f);',
    ].join('\n'),
    'migrations/002_drop.ts': [
      'export class Drop {',
      '  async up(queryRunner) {',
      "    await queryRunner.dropColumn('orders', 'a');",
      "    await queryRunner.dropColumn('orders', new TableColumn({ name: 'c', type: 'varchar' }));",
      "    await queryRunner.dropColumns('orders', ['e']);",
      '  }',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(findings, []);
});

test('migrations: MySQL RENAME TABLE moves the indexes of every renamed pair', () => {
  const findings = schemaFindings(
    {
      'migrations/001_init.sql': [
        'CREATE INDEX old_a_idx ON old_orders (a);',
        'CREATE INDEX other_a_idx ON old_items (a);',
      ].join('\n'),
      'migrations/002_rename.sql': 'RENAME TABLE old_orders TO orders, `old_items` TO `items`;\n',
      'migrations/003_index.sql':
        'CREATE INDEX orders_ab_idx ON orders (a, b);\nCREATE INDEX items_ab_idx ON items (a, b);\n',
    },
    'mysql',
  );
  assert.deepEqual(
    findings.map(({ file, line }) => [file, line]),
    [
      ['001_init.sql', 1],
      ['001_init.sql', 2],
    ],
  );
});

test('Prisma: a redundant index is reported once, at schema.prisma rather than in its migration', () => {
  const findings = schemaFindings({
    'prisma/schema.prisma': `datasource db {
  provider = "postgresql"
}

model Category {
  id      String @id
  storeId String
  slug    String
  @@index([storeId])
  @@unique([storeId, slug])
}
`,
    'prisma/migrations/20260101000000_init/migration.sql': [
      'CREATE TABLE "Category" ("id" TEXT NOT NULL, "storeId" TEXT NOT NULL, "slug" TEXT NOT NULL);',
      'CREATE INDEX "Category_storeId_idx" ON "Category"("storeId");',
      'CREATE UNIQUE INDEX "Category_storeId_slug_key" ON "Category"("storeId", "slug");',
    ].join('\n'),
  });
  assert.deepEqual(
    findings.map(({ file, line }) => [file, line]),
    [['schema.prisma', 9]],
  );
});

const sequelizeOrganization = `import { Column, DataType, Index, Model, PrimaryKey, Table, Unique } from 'sequelize-typescript';
@Table({
  tableName: 'Organizations',
  indexes: [{ name: 'organization_slug_index', fields: ['slug'], unique: true }],
})
export class Organization extends Model {
  @PrimaryKey
  @Column(DataType.UUID)
  id!: string;
  @Unique
  @Index
  @Column(DataType.STRING)
  slug!: string;
}
`;

test(
  'Sequelize: findings on one column name the decorator and advise removing it from the model',
  sourceOptions,
  () => {
    const findings = sourceFindings('sequelize', { 'src/organization.ts': sequelizeOrganization });
    const sync = '`sequelize.sync({ alter: true })` recreates every index the model declares.';
    assert.deepEqual(
      findings.map(({ line, message }) => [line, message]),
      [
        [
          13,
          'Unique constraint (slug) (`@Unique`) on `Organization` duplicates unique index `organization_slug_index` ' +
            '(slug), so this one only adds write cost and memory. Remove the `@Unique` decorator and drop it in a ' +
            `migration; ${sync}`,
        ],
        [
          13,
          'Index (slug) (`@Index`) on `Organization` duplicates unique index `organization_slug_index` (slug), so this ' +
            `one only adds write cost and memory. Remove the \`@Index\` decorator and drop it in a migration; ${sync}`,
        ],
      ],
    );
  },
);

test('Sequelize: an `indexes` entry repeating the primary key names the primary key', sourceOptions, () => {
  const source = `import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
@Table({
  tableName: 'Currencies',
  indexes: [{ name: 'currency_code_index', fields: ['code'], unique: true }],
})
export class Currency extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  code!: string;
}
`;
  const [finding] = sourceFindings('sequelize', { 'src/currency.ts': source });
  assert.equal(
    finding.message,
    'Unique index `currency_code_index` (code) on `Currency` duplicates the primary key (code), so this one only ' +
      "adds write cost and memory. Remove its entry from the model's `indexes` and drop it in a migration; " +
      '`sequelize.sync({ alter: true })` recreates every index the model declares.',
  );
  assert.equal(finding.suggestion, 'DROP INDEX CONCURRENTLY "currency_code_index";');
});

test('TypeORM: @Unique and @Index on the same columns are told apart', sourceOptions, () => {
  const source = `import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
@Entity('members')
@Unique(['tenantId', 'userId'])
@Index(['tenantId', 'userId'])
export class Member {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Column()
  tenantId!: string;
  @Column()
  userId!: string;
}
`;
  const [finding] = sourceFindings('typeorm', { 'src/member.ts': source });
  assert.match(
    finding.message,
    /^Index \(tenantId, userId\) \(`@Index`\) on `Member` duplicates unique constraint \(tenantId, userId\) \(`@Unique`\)/,
  );
});

test('TypeORM: an index inherited from a base class is reported once, at the base class', sourceOptions, () => {
  const base = `import { Column, Index, PrimaryGeneratedColumn } from 'typeorm';
export abstract class TenantBaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  schoolId!: string;
}
`;
  const entities = `import { Column, Entity, Index } from 'typeorm';
import { TenantBaseEntity } from './base.entity';
@Entity('years')
@Index(['schoolId', 'status'])
export class AcademicYear extends TenantBaseEntity {
  @Column()
  status!: string;
}
@Entity('exams')
@Index(['schoolId', 'classId'])
export class Exam extends TenantBaseEntity {
  @Column()
  classId!: string;
}
@Entity('families')
export class Family extends TenantBaseEntity {
  @Column()
  name!: string;
}
`;
  const findings = sourceFindings('typeorm', { 'src/base.entity.ts': base, 'src/entities.ts': entities });
  assert.deepEqual(
    findings.map(({ file, line, message }) => [file, line, message]),
    [
      [
        'base.entity.ts',
        8,
        'Index (schoolId) (`@Index`) declared in this base class is redundant on 2 of the 3 entities that inherit it ' +
          '(`AcademicYear`, `Exam`): each has another index that starts with the same columns, so there it only adds ' +
          'write cost and memory. Declare it only on the entities that still need it.',
      ],
    ],
  );
});

test('Drizzle: applying the fix removes the whole index line', (context) => {
  const source = `import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core';
export const orders = pgTable(
  'orders',
  { tenantId: uuid(), status: text() },
  (table) => [
    index('a_idx').on(table.tenantId),
    index('ab_idx').on(table.tenantId, table.status),
  ],
);
`;
  const { findings } = scanWithFixes(context, { ...drizzleStubs, 'src/schema.ts': source });
  const [finding] = findings.filter((candidate) => candidate.ruleId === ruleId);
  const { text } = applyChangesToText(source, requireFix(finding).changes);
  assert.equal(text, source.replace("    index('a_idx').on(table.tenantId),\n", ''));
});
