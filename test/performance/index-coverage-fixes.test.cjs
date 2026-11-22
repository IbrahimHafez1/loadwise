'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildFix, createFileCache } = require('../../lib/performance/site-fix.cjs');

const drizzleTable = `import { mysqlTable, index, int, varchar } from 'drizzle-orm/mysql-core';
export const orders = mysqlTable(
  'orders',
  { id: int('id'), status: varchar('status', { length: 24 }) },
  (row) => [
    index('by_id').on(row.id),
  ],
);
`;

function project(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-coverage-fix-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"shop"}');
  fs.writeFileSync(path.join(root, 'query.ts'), 'export const run = 1;\n');
  for (const [name, contents] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  return root;
}

function drizzleFinding(root) {
  return {
    ruleId: 'index-missing-filter',
    file: path.join(root, 'query.ts'),
    line: 1,
    column: 8,
    message:
      '`orders.status` is filtered here and no index starts with it. Add `index(...)`; on a live database build it ' +
      'with `CREATE INDEX ALGORITHM=INPLACE;`.',
    suggestion: "index('orders_status_id_idx').on(table.status, table.id)",
    related: [
      {
        file: path.join(root, 'orders.ts'),
        line: 2,
        column: 23,
        message: 'Table `orders` is declared here.',
      },
    ],
  };
}

function fixOf(finding) {
  return buildFix(finding, createFileCache(), { comments: false });
}

test('Drizzle fix: a project of hand-written SQL migrations needs review and a note naming the migrations folder', (context) => {
  const root = project(context, {
    'orders.ts': drizzleTable,
    'src/database/migrations/20261101-01-orders.sql': 'CREATE TABLE orders (id int);',
  });
  const fix = fixOf(drizzleFinding(root));
  assert.equal(fix.requiresReview, true);
  assert.match(fix.note, /hand-written SQL migrations/);
  assert.match(fix.note, /src\/database\/migrations/);
  assert.match(fix.note, /no index is created until/);
});

test('Drizzle fix: a drizzle-kit project is told to generate the migration, not to hand-write one', (context) => {
  const root = project(context, {
    'orders.ts': drizzleTable,
    'drizzle.config.ts': "export default { dialect: 'mysql', out: './drizzle' };",
    'drizzle/0000_init.sql': 'CREATE TABLE orders (id int);',
  });
  const fix = fixOf(drizzleFinding(root));
  assert.equal(fix.requiresReview, true);
  assert.doesNotMatch(fix.note, /hand-written/);
});
