import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { indexFindings, projectFiles, nativeAvailable, runOnNativeEngine } from './index-rules-fixtures.js';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.js';
import { findSourceFile } from '../types/source-files.js';
import type { FileMap } from '../types/project-files.js';
import { fileOf } from '../types/finding-fix.js';
import { withProgram } from './helpers.js';
import { analyzeFile } from '../../lib/performance/analyze.js';
import { checkRedundantSchemaIndexes } from '../../lib/performance/redundant-indexes.js';

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';
// schema.prisma and migration checks involve no TypeScript engine.
const fileOptions = { skip: onNativeEngine };
const ruleId = 'index-redundant-prefix';

function redundantFindings(findings: Finding[]) {
  return findings.filter((finding: Finding) => finding.ruleId === ruleId);
}

function redundantLines(findings: Finding[]) {
  return redundantFindings(findings).map(({ line }) => line);
}

import { drizzle as drizzleStubs } from './fixtures/schema/orm-stubs.js';

function drizzleLines(extras: string) {
  const source = `import { pgTable, uuid, text, index, uniqueIndex, sql } from 'drizzle-orm/pg-core';
export const orders = pgTable(
  'orders',
  { id: uuid().primaryKey(), tenantId: uuid(), status: text(), name: text() },
  (table) => [
${extras}
  ],
);
`;
  return redundantLines(indexFindings(source, drizzleStubs));
}

test('Drizzle: a prefix index and an exact duplicate are reported at their declaration', () => {
  const lines = drizzleLines(`    index('a_idx').on(table.tenantId),
    index('ab_idx').on(table.tenantId, table.status),
    index('dup_one').on(table.name),
    index('dup_two').on(table.name),`);
  assert.deepEqual(lines, [6, 9]);
});

test('Drizzle: the message names both indexes and the DROP INDEX statement', () => {
  const source = `import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core';
export const orders = pgTable('orders', { tenantId: uuid(), status: text() }, (table) => [
  index('a_idx').on(table.tenantId),
  index('ab_idx').on(table.tenantId, table.status),
]);
`;
  const [finding] = redundantFindings(indexFindings(source, drizzleStubs));
  assert.equal(
    finding.message,
    'Index `a_idx` (tenantId) on `orders` is a leading prefix of index `ab_idx` (tenantId, status), so it serves no ' +
      'lookup the longer index cannot and only adds write cost and memory. Drop the shorter index.',
  );
  assert.equal(finding.suggestion, 'DROP INDEX CONCURRENTLY "a_idx";');
});

test('Drizzle: unique prefixes, other column orders and different keys are not redundant', () => {
  const lines = drizzleLines(`    uniqueIndex('u_idx').on(table.tenantId),
    index('tenant_status_idx').on(table.tenantId, table.status),
    index('status_idx').on(table.status),
    index('name_status_idx').on(table.name, table.status),
    index('tenant_desc_idx').on(table.tenantId.desc()),`);
  assert.deepEqual(lines, []);
});

test('Drizzle: partial, expression and non-btree indexes are skipped', () => {
  const lines = drizzleLines(`    index('p_idx').on(table.tenantId).where(sql\`status = 'open'\`),
    index('pa_idx').on(table.tenantId, table.status),
    index('e_idx').on(sql\`lower(\${table.name})\`),
    index('ea_idx').on(sql\`lower(\${table.name})\`, table.status),
    index('g_idx').using('hash', table.status),
    index('ga_idx').on(table.status, table.name),`);
  assert.deepEqual(lines, []);
});

test('Drizzle: a unique index is redundant only next to an identical unique or primary key', () => {
  const lines = drizzleLines(`    uniqueIndex('u_one').on(table.tenantId, table.status),
    uniqueIndex('u_two').on(table.tenantId, table.status),
    uniqueIndex('u_name').on(table.name),
    index('name_status_idx').on(table.name, table.status),`);
  assert.deepEqual(lines, [7]);
});

test('Drizzle: a plain index repeating a unique index is redundant, the unique one is kept', () => {
  const lines = drizzleLines(`    index('plain_idx').on(table.tenantId, table.status),
    uniqueIndex('unique_idx').on(table.tenantId, table.status),`);
  assert.deepEqual(lines, [6]);
});

test('TypeORM: a single-column @Index repeated by a composite one is reported', fileOptions, () => {
  const source = `import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
@Entity('orders')
@Index(['tenantId', 'status'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Index()
  @Column()
  tenantId!: string;
  @Column()
  status!: string;
}
`;
  const findings = withProgram('', projectFiles('typeorm', { 'entities.ts': source }), (program: ProgramAdapter) =>
    analyzeFile(
      program,
      findSourceFile(program, (file) => path.resolve(file.fileName).endsWith(path.join('typeorm-app', 'entities.ts'))),
    ),
  );
  assert.deepEqual(redundantLines(findings), [9]);
});

const prismaHeader = `datasource db {
  provider = "postgresql"
}
`;

function withProject<Result>(files: FileMap, run: (root: string) => Result): Result {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-check-redundant-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"pg":"8.0.0"}}');
    for (const [name, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), contents);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function schemaFindings(files: FileMap) {
  return withProject(files, (root: string) =>
    checkRedundantSchemaIndexes(root).map((finding) => [path.basename(fileOf(finding)), finding.line, finding.ruleId]),
  );
}

test(
  'Prisma: @@index prefixes are reported on their schema line, constraints and options are kept',
  fileOptions,
  () => {
    const schema = `${prismaHeader}
model Order {
  id       String @id
  tenantId String
  status   String
  name     String
  code     String @unique
  @@index([tenantId])
  @@index([tenantId, status])
  @@unique([name])
  @@index([name, status])
  @@index([status(sort: Desc)])
  @@index([status, tenantId])
  @@index([code, status])
  @@index([status], type: Hash)
  @@index([status, name], type: Hash)
}
`;
    assert.deepEqual(schemaFindings({ 'prisma/schema.prisma': schema }), [['schema.prisma', 11, ruleId]]);
  },
);

test('Prisma: an index repeating the leading primary key columns is reported', fileOptions, () => {
  const schema = `${prismaHeader}
model Member {
  tenantId String
  userId   String
  @@id([tenantId, userId])
  @@index([tenantId])
}
`;
  assert.deepEqual(schemaFindings({ 'prisma/schema.prisma': schema }), [['schema.prisma', 9, ruleId]]);
});

test('migrations: CREATE INDEX prefixes are reported at their statement, dropped ones are not', fileOptions, () => {
  const lines = schemaFindings({
    'migrations/001_init.sql': [
      'CREATE TABLE orders (id int PRIMARY KEY, tenant_id int, status text, name text);',
      'CREATE INDEX orders_tenant_idx ON orders (tenant_id);',
      'CREATE INDEX orders_tenant_status_idx ON orders (tenant_id, status);',
      'CREATE INDEX orders_status_idx ON orders (status);',
      'CREATE INDEX orders_status_desc_idx ON orders (status DESC, name);',
      'CREATE UNIQUE INDEX orders_name_key ON orders (name);',
      'CREATE INDEX orders_name_status_idx ON orders (name, status);',
      'CREATE INDEX orders_partial_idx ON orders (status) WHERE name IS NULL;',
      'CREATE INDEX orders_hash_idx ON orders USING hash (name);',
      'CREATE INDEX orders_gone_idx ON orders (status, name);',
    ].join('\n'),
    'migrations/002_cleanup.sql': 'DROP INDEX orders_gone_idx;\n',
  });
  assert.deepEqual(lines, [['001_init.sql', 2, ruleId]]);
});

test('migrations: the same table in separate migration folders is not compared', fileOptions, () => {
  const lines = schemaFindings({
    'service-a/migrations/001.sql': 'CREATE INDEX a_idx ON items (owner_id);',
    'service-b/migrations/001.sql': 'CREATE INDEX ab_idx ON items (owner_id, kind);',
  });
  assert.deepEqual(lines, []);
});

test(
  'the same redundant-index findings on the TypeScript 7 engine',
  { skip: onNativeEngine || !nativeAvailable() },
  () => {
    const result = runOnNativeEngine(import.meta.filename);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass [1-9]\d*/);
  },
);
