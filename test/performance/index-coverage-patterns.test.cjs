'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { indexFindings, projects, projectFiles } = require('./index-rules-fixtures.cjs');

const patternSchema = `import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core';
export { eq, and, like, ilike, sql } from 'drizzle-orm';
export type { Database } from 'drizzle-orm/pg-core';
export const categories = pgTable(
  'categories',
  { id: uuid().primaryKey(), name: text().notNull(), status: text().notNull(), displayOrder: text().notNull() },
  (table) => [index('categories_status_order_idx').on(table.status, table.displayOrder)],
);
export const diplomas = pgTable(
  'diplomas',
  { id: uuid().primaryKey(), status: text().notNull(), createdAt: text().notNull() },
  (table) => [index('diplomas_status_idx').on(table.status)],
);
`;

function lintCategories(body) {
  const source = `import { categories, diplomas, eq, and, like, ilike, sql, type Database } from '${projects.drizzle}schema';
declare const db: Database;
export async function run(term: string) {
${body}
}`;
  return indexFindings(source, projectFiles('drizzle', { 'schema.ts': patternSchema }));
}

test('leading-wildcard LIKE, ILIKE and fuzzy matches never suggest a btree index on the column', () => {
  const findings = lintCategories(`  await db.select().from(categories).where(like(categories.name, '%' + term + '%'));
  await db.select().from(categories).where(ilike(categories.name, \`%\${term}%\`));
  await db.select().from(categories).where(and(eq(categories.status, 'active'), ilike(categories.name, '%x%')));
  await db.select().from(categories).where(sql\`LOWER(\${categories.name}) LIKE \${term}\`);`);
  assert.deepEqual(
    findings.filter((finding) => finding.ruleId === 'index-missing-filter' && /name/.test(finding.message)),
    [],
  );
  for (const finding of findings) assert.doesNotMatch(finding.suggestion ?? '', /table\.name\)$/);
});

test('a sort led by a derived rank is not served by a (status, createdAt) index and is not suggested', () => {
  const findings =
    lintCategories(`  await db.select().from(categories).where(eq(categories.status, 'active')).orderBy(sql\`rank desc\`, categories.displayOrder).limit(5);
  await db.select().from(categories).where(eq(categories.status, 'active')).orderBy(categories.displayOrder).limit(5);`);
  assert.deepEqual(findings, []);
});

test('a status listing already narrowed by an index on the status is contextual, not a default order finding', () => {
  const findings = lintCategories(
    `  await db.select().from(diplomas).where(eq(diplomas.status, 'published')).orderBy(diplomas.createdAt).limit(20);`,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'index-missing-order');
  assert.match(findings[0].contextualReason, /^An index on `status` already narrows this read/);
});
