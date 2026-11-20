'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');

function fixtures(dialect) {
  const root = 'node_modules/drizzle-orm/' + dialect;
  return {
    [root + '/db.d.ts']: `import {Query} from './query-builders/select';
import {Relations} from './query-builders/query';
export class Database {
  readonly query: { users: Relations };
  select(): {from(table: string): Query};
  update(table: string): {set(fields: object): Query};
  insert(table: string): {values(fields: object): Query};
  delete(table: string): Query;
}`,
    [root + '/query-builders/select.d.ts']: `export class Query extends Promise<unknown[]> {
  where(predicate: unknown): Query;
  returning(): Query;
  limit(size: number): Query;
  prepare(name?: string): PreparedQuery;
  execute(): Promise<unknown[]>;
  run(): unknown[];
  toSQL(): object;
}
export class PreparedQuery { execute(): Promise<unknown[]> }`,
    [root + '/query-builders/query.d.ts']: `import {Query} from './select';
export class Relations {findFirst(options: object): Query; findMany(options: object): Query;}`,
  };
}

test('a new program at the same path can introduce Drizzle through a re-export', () => {
  const source =
    "import type {Database} from './storage';\ndeclare const db: Database;\nasync function purge(ids: number[]) { for (const id of ids) await db.delete('jobs').where({id}); }";
  assert.deepEqual(
    lint(source, {
      'storage.ts': 'export interface Database { delete(table: string): { where(predicate: unknown): Promise<void> } }',
    }),
    [],
  );
  const files = { ...fixtures('pg-core'), 'storage.ts': "export {Database} from 'drizzle-orm/pg-core/db';" };
  assert.deepEqual(
    lint(source, files).map(({ line, ruleId }) => [line, ruleId]),
    [[3, 'drizzle-query-in-loop']],
  );
});

for (const dialect of ['pg-core', 'mysql-core', 'sqlite-core']) {
  test('Drizzle only reports executed queries in ' + dialect, () => {
    const findings = lint(
      `import type {Database} from 'drizzle-orm/${dialect}/db';
async function load(db: Database, ids: number[]) {
  const prepared = db.select().from('users').prepare('ids');
  for (const id of ids) {
    const statement = db.select().from('users').where({id});
    db.select().from('users').prepare('users');
    await db.select().from('users').where({id});
    await db.query.users.findFirst({where: {id}});
    db.delete('users').where({id}).execute();
    await prepared.execute();
    await db.update('users').set({active: true}).where({id}).execute();
    db.insert('users').values({id});
  }
  const pending = db.delete('users');
  await db.delete('users');
  await db.update('users').set({active: true}).returning().execute();
  await db.delete('users').where(undefined);
  await db.delete('users').where({id: 1});
  await db.delete('users').limit(1);
  db.update('users').set({active: true}).toSQL();
  db.update('users').set({active: true}).prepare();
  await db.select().from('users').where({ids});
}`,
      fixtures(dialect),
    );
    assert.deepEqual(
      findings.map(({ line, ruleId }) => [line, ruleId]),
      [7, 8, 9, 10, 11].map((line) => [line, 'drizzle-query-in-loop']),
    );
  });
}

test('insert distinguishes multi-row slices from overlapping slices and individual records', () => {
  const source = `import type { Database } from 'drizzle-orm/pg-core/db';
    async function save(db: Database, names: string[]) {
      const size = 100;
      for (let i = 0; i < names.length; i += size) {
        const rows = [...new Set(names.slice(i, i + size))].map(name => ({name}));
        await db.insert('people').values(rows);
      }
      for (let i = 0; i < names.length; i++) {
        await db.insert('people').values(names.slice(i, i + size));
      }
      for (const name of names) await db.insert('people').values({name});
      for (const row of names.map(name => ({name}))) await db.insert('people').values(row);
    }`;
  assert.deepEqual(
    lint(source, fixtures('pg-core'))
      .filter((finding) => finding.ruleId === 'drizzle-query-in-loop')
      .map((finding) => finding.line),
    [9, 11, 12],
  );
});

test('SQLite execution without await is checked, and unrelated query builders stay clean', () => {
  const files = fixtures('sqlite-core');
  for (const [name, contents] of Object.entries(files))
    files[name.replace('drizzle-orm/sqlite-core', 'custom-driver')] = contents;
  const findings = lint(
    `import type {Database} from 'drizzle-orm/sqlite-core/db';
import type {Database as Custom} from 'custom-driver/db';
function use(db: Database, other: Custom, ids: number[]) {
  for (const id of ids) {
    db.select().from('users').where({id}).run();
    other.select().from('users').where({id}).run();
    other.delete('users').execute();
  }
  db.delete('users').run();
}`,
    files,
  );
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [[5, 'drizzle-query-in-loop']],
  );
});
