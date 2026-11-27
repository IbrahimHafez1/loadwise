import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { scanWithFixes } from './site-fix-helpers.js';
import type { FixChange } from '../../lib/shared/types.js';
import { fixOf } from '../types/finding-fix.js';

// The header object a MySQL driver returns from an insert.
interface InsertHeader {
  insertId?: number | string | null;
}

const stubs = {
  'node_modules/drizzle-orm/index.d.ts': 'export function sql(parts: TemplateStringsArray): object;',
  'node_modules/drizzle-orm/mysql2/index.d.ts': `export class MySql2Database {
    insert(table: object): { values(row: object): Promise<[{ insertId: number }]> };
    execute(query: object): Promise<unknown[]>;
  }`,
  'node_modules/drizzle-orm/mysql-core/index.d.ts': `export function mysqlTable(name: string, columns: object): object;
    export function int(name: string): {autoincrement(): object};`,
};

const declarations = `import { sql } from 'drizzle-orm';
import { mysqlTable, int } from 'drizzle-orm/mysql-core';
import { MySql2Database } from 'drizzle-orm/mysql2';
const orders = mysqlTable('orders', {id: int('id').autoincrement()});
const fixed = mysqlTable('fixed', {id: int('id')});
declare const db: MySql2Database;
declare const other: MySql2Database;
declare function localSql(parts: TemplateStringsArray): object;
`;
const insert = "await db.insert(orders).values({name: 'a'});";
const query = 'const result = await db.execute(sql`SELECT LAST_INSERT_ID() AS id`);';
const read = 'const id = (result[0] as Array<{ id: number }>)[0]!.id;';
const rowRead = 'const firstRow = (result[0] as Array<{id?: number | string}>)?.[0];';
const convertedId = 'const id = Number(firstRow?.id ?? 0);';
const lookupComment = '// Get the last inserted ID using raw SQL';

test('mysql2 generated ID patch retains the INSERT, requires review, and eliminates the extra query', (context) => {
  const source = [declarations, 'async function run() {', insert, query, read, 'return id;', '}'].join('\n');
  const scan = (text: string) =>
    scanWithFixes(context, { ...stubs, 'src.ts': text }).findings.filter(
      (finding) => finding.ruleId === 'drizzle-last-insert-id',
    );
  const [finding] = scan(source);
  assert.equal(fixOf(finding).requiresReview, true);
  let fixed = source;
  for (const change of fixOf(finding).changes) fixed = fixed.replace(change.before, () => change.after);
  assert.ok(fixed.includes('const result = ' + insert));
  assert.match(fixed, /const id =\s+result\?\.\[0\]\?\.insertId \?\?/);
  assert.ok(fixed.includes('(await db.execute(sql`SELECT LAST_INSERT_ID() AS id`))'));
  assert.deepEqual(scan(fixed), []);
});

test('insert headers skip the query; absent metadata preserves row conversion and lookup errors', async (context) => {
  for (const statements of [[read], [rowRead, convertedId]]) {
    const source = [
      declarations,
      'async function run() {',
      insert,
      lookupComment,
      query,
      ...statements,
      'return id;',
      '}',
    ].join('\n');
    const scan = (code: string) =>
      scanWithFixes(context, { ...stubs, 'src.ts': code }).findings.filter(
        ({ ruleId }) => ruleId === 'drizzle-last-insert-id',
      );
    const [finding] = scan(source);
    assert.ok(fixOf(finding).requiresReview);
    const updated = fixOf(finding).changes.reduce(
      (text: string, change: FixChange) => text.replace(change.before, () => change.after),
      source,
    );
    assert.ok(!updated.includes(lookupComment));
    if (statements.length === 2) {
      assert.match(updated, /const firstRowId =\s+result\?\.\[0\]\?\.insertId \?\?/);
      assert.match(updated, /Number\(firstRowId \?\? 0\)/);
    }
    assert.deepEqual(scan(updated), []);
    const compile = (text: string) => {
      const body = ts.transpileModule(text.slice(text.indexOf('async function run')), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return new Function('db', 'orders', 'sql', body + '\nreturn run();');
    };
    const originalRun = compile(source);
    const fixedRun = compile(updated);
    const metadataCases: (readonly InsertHeader[] | undefined)[] = [
      undefined,
      [],
      [{}],
      [{ insertId: null }],
      [{ insertId: 0 }],
      [{ insertId: '37' }],
    ];
    for (const metadata of metadataCases) {
      const headerId = metadata?.[0]?.insertId;
      let queries = 0;
      const db = {
        insert: () => ({ values: () => metadata }),
        execute: () => {
          queries++;
          return [[{ id: headerId ?? '86' }], []];
        },
      };
      const expected = await originalRun(db, {}, () => ({}));
      queries = 0;
      assert.equal(await fixedRun(db, {}, () => ({})), expected);
      assert.equal(queries, headerId == null ? 1 : 0);
    }
    const emptyDb = { insert: () => ({ values: () => undefined }), execute: () => [[], []] };
    if (statements.length === 2) assert.equal(await fixedRun(emptyDb, {}, () => ({})), 0);
    else
      await assert.rejects(
        fixedRun(emptyDb, {}, () => ({})),
        TypeError,
      );
    emptyDb.execute = () => {
      throw new Error('lookup failed');
    };
    await assert.rejects(
      fixedRun(emptyDb, {}, () => ({})),
      /lookup failed/,
    );
  }
});

test('ambiguous ID sources are ignored and additional row consumers or comments withhold the patch', (context) => {
  const cases = [
    [insert.replace('name:', 'id:'), query, read],
    [insert.replace('orders', 'fixed'), query, read],
    [insert.replace("{name: 'a'}", "[{name: 'a'}]"), query, read],
    [insert.replace("{name: 'a'}", "{...{name: 'a'}}"), query, read],
    [insert, query.replace('db.execute', 'other.execute'), read],
    [insert, query.replace('sql`', 'localSql`'), read],
    [insert, query.replace('() AS', '(2) AS'), read],
    [insert, 'await db.execute({});', query, read],
    [insert, query, read, 'console.log(result);'],
    [insert, '// query logging contract', query, read],
    [insert, lookupComment + '\n// preserve this', query, read],
    [insert, '// @ts-expect-error', query, read],
    [insert, query, rowRead, convertedId, 'return firstRow;'],
    [insert, query, rowRead, 'const id = Number(firstRow?.other ?? 0);'],
  ];
  const functions = cases.map((lines, index) => ['async function run' + index + '() {', ...lines, '}'].join('\n'));
  const { findings } = scanWithFixes(context, { ...stubs, 'src.ts': declarations + functions.join('\n') });
  const ids = findings.filter((finding) => finding.ruleId === 'drizzle-last-insert-id');
  assert.equal(ids.length, 6);
  assert.ok(ids.every((finding) => !finding.fix));
});
