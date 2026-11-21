'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { scanWithFixes } = require('./site-fix-helpers.cjs');

const files = {
  'node_modules/drizzle-orm/index.d.ts':
    'export function eq(column: any, value: any): any; export function and(...terms: any[]): any;',
  'node_modules/drizzle-orm/mysql-core/index.d.ts': `
export function mysqlTable<T>(name: string, columns: T, indexes: (table: T) => any[]): T;
export function int(name: string): any;
export function uniqueIndex(name: string): { on(...columns: any[]): any };
export function index(name: string): { on(...columns: any[]): any };`,
  'node_modules/drizzle-orm/mysql-core/db.d.ts': `
export class Database {
  select(): { from(table: any): { where(condition: any): { limit(count: number): Promise<any[]> } } };
  delete(table: any): { where(condition: any): Promise<any> };
  insert(table: any): { values(fields: any): Promise<any> };
}`,
};
const header = `
import { and, eq } from 'drizzle-orm';
import { mysqlTable, int, uniqueIndex, index } from 'drizzle-orm/mysql-core';
import type { Database } from 'drizzle-orm/mysql-core/db';
const links = mysqlTable('links', { owner: int('owner'), product: int('product') },
  table => [uniqueIndex('unique_link').on(table.owner, table.product)]);
`;
const predicate = 'and(eq(links.owner, owner), eq(links.product, product))';
const lookup = `const [found] = await db.select().from(links).where(${predicate}).limit(1);`;
const insert = 'if (found) throw Error("already linked"); await db.insert(links).values({ owner, product });';
const remove = `if (!found) throw Error("missing link"); await db.delete(links).where(${predicate});`;

function matching(source) {
  return lint(source, files).filter(({ ruleId }) => ruleId === 'drizzle-write-preflight');
}

function example(body) {
  return `async function run(db: Database, owner: number, product: number, other: Database) { ${body} }`;
}

test('reports only the guard-only read of the matching unique key before insert or delete', () => {
  for (const operation of [insert, remove]) {
    const [finding] = matching(header + example(lookup + operation));
    assert.match(finding.message, /round trip/);
    assert.equal(finding.fix, undefined);
  }
});

test('mysql2 DELETE can check the write result for a missing row after individual review', async (context) => {
  const mysqlFiles = {
    ...files,
    'node_modules/drizzle-orm/mysql2/index.d.ts':
      "import { Database } from '../mysql-core/db'; export class MySql2Database extends Database {}",
  };
  const mysqlHeader = header.replace(
    "import type { Database } from 'drizzle-orm/mysql-core/db';",
    "import type { MySql2Database as Database } from 'drizzle-orm/mysql2';",
  );
  const body = [
    '  ' + lookup,
    '  if (!found) throw Error("missing link");',
    '  await db.delete(links).where(' + predicate + ');',
    '  return "deleted";',
  ].join('\n');
  const source = mysqlHeader + example('\n' + body + '\n');
  const scan = (content, tests = {}) =>
    scanWithFixes(context, { ...mysqlFiles, ...tests, 'service.ts': content }).findings.filter(
      (finding) => finding.ruleId === 'drizzle-write-preflight',
    );
  const [finding] = scan(source);
  assert.equal(finding.fix?.requiresReview, true);
  const mock = (value) => `const database = { delete: mockReturnValue({ where: mockResolvedValue(${value}) }) };`;
  assert.equal(scan(source, { 'service.spec.ts': mock('undefined') })[0].fix, undefined);
  assert.equal(scan(source, { '__tests__/service.test.ts': mock('[]') })[0].fix, undefined);
  assert.equal(scan(source, { 'service.spec.ts': mock('[{ affectedRows: 0 }, []]') })[0].fix?.requiresReview, true);
  let edited = source;
  for (const change of finding.fix.changes) edited = edited.replace(change.before, () => change.after);
  assert.ok(edited.includes('.affectedRows === 0'));
  assert.deepEqual(scan(edited), []);
  const functionText = require('typescript').transpile(edited.slice(edited.indexOf('async function run')));
  const run = new Function('eq', 'and', 'links', functionText + '\nreturn run;')(
    (column, value) => [column, value],
    (...terms) => terms,
    { owner: 'owner', product: 'product' },
  );
  const calls = [];
  const database = (affectedRows) => ({
    delete() {
      return {
        where: async (filter) => {
          calls.push(filter);
          return [{ affectedRows }];
        },
      };
    },
  });
  assert.equal(await run(database(1), 12, 34), 'deleted');
  await assert.rejects(run(database(0), 12, 34), /missing link/);
  assert.deepEqual(
    calls,
    Array(2).fill([
      ['owner', 12],
      ['product', 34],
    ]),
  );
  for (const unsupported of [
    source.replace(lookup, '// Preserve this query directive\n' + lookup),
    source.replace(lookup, 'const observe = () => found;\n' + lookup),
    source.replace('if (!found)', '// @ts-expect-error\n  if (!found)'),
    source.replace(mysqlHeader, header),
  ])
    assert.ok(scan(unsupported).every((item) => !item.fix));
});

test('ignores different inputs, row-dependent behavior, nonunique keys, and unrelated APIs', () => {
  const cases = [
    [header, lookup + insert.replace('{ owner, product }', '{ owner: product, product }')],
    [header, lookup + remove.replace('db.delete', 'other.delete')],
    [header, lookup + remove.replace('links.owner, owner', 'links.owner, product')],
    [header, lookup + remove.replace('"missing link"', 'String(found)')],
    [header, lookup + insert + ' return found;'],
    [header, lookup + 'if (found) throw Error(); await audit(); await db.insert(links).values({ owner, product });'],
    [header.replace("uniqueIndex('unique_link')", "index('nonunique_link')"), lookup + insert],
    [
      header.replace(
        "import { and, eq } from 'drizzle-orm';",
        'declare function and(...args:any[]):any; declare function eq(...args:any[]):any;',
      ),
      lookup + remove,
    ],
    [header, 'await db.insert(links).values({owner,product});'],
    [header, `const [result] = await db.delete(links).where(${predicate}); if (!result.affectedRows) throw Error();`],
  ];
  assert.deepEqual(
    cases.flatMap(([prefix, body]) => matching(prefix + example(body))),
    [],
  );
});
