import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { buildFix, createFileCache } from '../../lib/performance/site-fix.js';
import type { Finding, FindingFix } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';
import { fixNoteOf } from '../types/fix-note.js';

const drizzleTable = `import { mysqlTable, index, int, varchar } from 'drizzle-orm/mysql-core';
export const orders = mysqlTable(
  'orders',
  { id: int('id'), status: varchar('status', { length: 24 }) },
  (row) => [
    index('by_id').on(row.id),
  ],
);
`;

function project(context: TestContext, files: FileMap) {
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

function drizzleFinding(root: string) {
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

function fixOf(finding: Finding): FindingFix {
  const fix = buildFix(finding, createFileCache(), { comments: false });
  assert.ok(fix, 'expected the finding to carry a fix');
  return fix;
}

test('Drizzle fix: a project of hand-written SQL migrations needs review and a note naming the migrations folder', (context) => {
  const root = project(context, {
    'orders.ts': drizzleTable,
    'src/database/migrations/20261101-01-orders.sql': 'CREATE TABLE orders (id int);',
  });
  const fix = fixOf(drizzleFinding(root));
  assert.equal(fix.requiresReview, true);
  assert.match(fixNoteOf(fix), /hand-written SQL migrations/);
  assert.match(fixNoteOf(fix), /src\/database\/migrations/);
  assert.match(fixNoteOf(fix), /no index is created until/);
});

test('Drizzle fix: a drizzle-kit project is told to generate the migration, not to hand-write one', (context) => {
  const root = project(context, {
    'orders.ts': drizzleTable,
    'drizzle.config.ts': "export default { dialect: 'mysql', out: './drizzle' };",
    'drizzle/0000_init.sql': 'CREATE TABLE orders (id int);',
  });
  const fix = fixOf(drizzleFinding(root));
  assert.equal(fix.requiresReview, true);
  assert.doesNotMatch(fixNoteOf(fix), /hand-written/);
});
