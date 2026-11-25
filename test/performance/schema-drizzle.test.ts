import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { withProgram } from './helpers.js';
import { drizzle } from './fixtures/schema/orm-stubs.js';
import { drizzleTableFromCall, drizzleColumn } from '../../lib/performance/schema/drizzle-schema.js';
import { coverage, patternIndex, expressionIndex } from '../../lib/performance/schema/model.js';
import type { Node, SourceFile } from 'typescript';
import type { CheckerAdapter, ProgramAdapter } from '../../lib/shared/types.js';
import type { SchemaTable } from '../../lib/performance/types/schema-model.js';
import type { FileMap } from '../types/project-files.js';
import { initializerOf, requireColumn, requireIndex, requireTable, sourceFileAt } from '../types/schema-lookups.js';

const projectDirectory = '../fixtures/schema/drizzle-app/';

// Condensed from a Drizzle pg workspace app (keyset index with desc columns) and a Drizzle MySQL
// shop (composite user_last_updated_idx).
const schema = `import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, pgSchema, uuid, text, integer, boolean, timestamp, index, unique, uniqueIndex, primaryKey, check } from 'drizzle-orm/pg-core';
import { mysqlTable, int, varchar, timestamp as mysqlTimestamp, index as mysqlIndex } from 'drizzle-orm/mysql-core';

export const statusEnum = pgEnum('status', ['open', 'closed']);
export const organizations = pgTable('organizations', { id: uuid().primaryKey(), slug: text().unique() });
export const cases = pgTable(
  'cases',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    name: text().notNull(),
    email: text('email'),
    archived: boolean('archived'),
    status: statusEnum('status'),
    head: integer().notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    requestKey: uuid('request_key'),
  },
  (table) => [
    check('cases_head_check', sql\`\${table.head} >= 0\`),
    unique('cases_organization_request_key').on(table.organizationId, table.requestKey),
    index('cases_organization_updated').on(table.organizationId, table.updatedAt.desc().nullsFirst(), table.id.desc()),
    index('cases_name_trgm').using('gin', table.name.op('gin_trgm_ops')),
    uniqueIndex('cases_email_lower').on(sql\`lower(\${table.email})\`),
    index('cases_open').on(table.head).where(sql\`\${table.status} = 'open'\`),
  ],
);
export const memberships = pgTable(
  'memberships',
  { organizationId: uuid('organization_id').notNull(), userId: uuid('user_id').notNull() },
  (table) => ({ pk: primaryKey({ columns: [table.organizationId, table.userId] }) }),
);
const auth = pgSchema('auth');
export const sessions = auth.table('sessions', { id: uuid().primaryKey(), token: text() });
export const opaque = pgTable('opaque', { id: uuid().primaryKey() }, (table) => [makeIndexes(table)]);
declare function makeIndexes(table: unknown): unknown;
export const abandonedCarts = mysqlTable(
  'abandoned_carts',
  {
    id: int('id').primaryKey(),
    userId: int('user_id'),
    guestEmail: varchar('guest_email', { length: 255 }),
    lastUpdated: mysqlTimestamp('last_updated').notNull().defaultNow(),
  },
  (table) => [mysqlIndex('user_last_updated_idx').on(table.userId, table.lastUpdated)],
);
`;

interface SchemaScan {
  tables: Map<string, SchemaTable>;
  checker: CheckerAdapter;
  sourceFile: SourceFile;
}

function withSchema(main: string, callback: (scan: SchemaScan) => void): void {
  const files: FileMap = { [projectDirectory + 'schema.ts']: schema };
  for (const [name, contents] of Object.entries(drizzle)) files[projectDirectory + name] = contents;
  return withProgram(main, files, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const checker = program.getTypeChecker();
    const schemaFile = sourceFileAt(
      program,
      path.resolve(import.meta.dirname, 'virtual-project', projectDirectory, 'schema.ts'),
    );
    const tables = new Map<string, SchemaTable>();
    ts.forEachChild(schemaFile, function visit(node: Node): void {
      if (ts.isCallExpression(node)) {
        const table = drizzleTableFromCall(node, checker);
        if (table) tables.set(table.dbName, table);
      }
      ts.forEachChild(node, visit);
    });
    return callback({ tables, checker, sourceFile });
  });
}

test('reads columns, chained constraints and the extras array', () => {
  withSchema('export {};', ({ tables }) => {
    const cases = requireTable(tables, 'cases');
    assert.equal(cases.dialect, 'postgres');
    assert.equal(cases.complete, true);
    assert.equal(requireColumn(cases, 'organizationId').dbName, 'organization_id');
    assert.deepEqual(requireColumn(cases, 'organizationId').foreignKey, { table: 'organizations', column: 'id' });
    assert.equal(requireColumn(cases, 'archived').type, 'boolean');
    assert.equal(requireColumn(cases, 'status').type, 'enum');
    assert.equal(coverage(cases, 'id'), 'leading');
    assert.equal(coverage(cases, 'organizationId'), 'leading');
    assert.equal(coverage(cases, 'updatedAt'), 'non-leading');
    assert.equal(coverage(cases, 'head'), 'none', 'the partial index does not count');
    assert.equal(patternIndex(cases, 'name'), true);
    assert.equal(expressionIndex(cases, 'lower(email)'), true);
    const sorted = requireIndex(cases, (index) => index.name === 'cases_organization_updated');
    assert.deepEqual(sorted.keys, [
      { column: 'organizationId' },
      { column: 'updatedAt', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ]);
    assert.match(requireIndex(cases, (index) => index.name === 'cases_open').predicate ?? '', /status/);
  });
});

test('reads object-form extras, pgSchema tables and MySQL tables', () => {
  withSchema('export {};', ({ tables }) => {
    const memberships = requireTable(tables, 'memberships');
    assert.equal(coverage(memberships, 'organizationId'), 'leading');
    assert.equal(coverage(memberships, 'userId'), 'non-leading');
    assert.equal(requireTable(tables, 'auth.sessions').columns.has('token'), true);
    assert.equal(requireTable(tables, 'organizations').indexes.length, 2, 'primaryKey() and unique() on columns');
    const carts = requireTable(tables, 'abandoned_carts');
    assert.equal(carts.dialect, 'mysql');
    assert.equal(coverage(carts, 'userId'), 'leading');
    assert.equal(coverage(carts, 'lastUpdated'), 'non-leading');
  });
});

test('marks a table whose extras cannot be read as incomplete', () => {
  withSchema('export {};', ({ tables }) => {
    assert.equal(requireTable(tables, 'opaque').complete, false);
  });
});

test('resolves a column reference at a query site to its table', () => {
  const main = `import { cases } from '${projectDirectory}schema';
export const column = cases.organizationId;
export const missing = cases.toString;`;
  withSchema(main, ({ checker, sourceFile }) => {
    const [first, second] = sourceFile.statements.slice(1).map(initializerOf);
    assert.ok(first && second);
    const resolved = drizzleColumn(first, checker);
    assert.ok(resolved);
    assert.equal(resolved.table.dbName, 'cases');
    assert.equal(resolved.column, 'organizationId');
    assert.equal(drizzleColumn(second, checker), undefined);
  });
});
