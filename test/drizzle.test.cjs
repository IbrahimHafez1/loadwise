'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {lint} = require('./helpers.cjs');

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
  const source = "import type {Database} from './storage';\ndeclare const db: Database;\nasync function purge() { await db.delete('jobs'); }";
  assert.deepEqual(lint(source, {'storage.ts': 'export interface Database { delete(table: string): Promise<void> }'}), []);
  const files = {...fixtures('pg-core'), 'storage.ts': "export {Database} from 'drizzle-orm/pg-core/db';"};
  assert.deepEqual(lint(source, files).map(({line, ruleId}) => [line, ruleId]), [[3, 'drizzle-unfiltered-write']]);
});

for (const dialect of ['pg-core', 'mysql-core', 'sqlite-core']) {
  test('Drizzle only reports executed queries and clearly unfiltered mutations in ' + dialect, () => {
    const findings = lint(`import type {Database} from 'drizzle-orm/${dialect}/db';
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
}`, fixtures(dialect));
    assert.deepEqual(findings.map(({line,ruleId}) => [line,ruleId]), [
      ...[7,8,9,10,11].map(line => [line,'drizzle-query-in-loop']),
      ...[15,16,17].map(line => [line,'drizzle-unfiltered-write']),
    ]);
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
  assert.deepEqual(lint(source, fixtures('pg-core')).filter(finding => finding.ruleId === 'drizzle-query-in-loop')
    .map(finding => finding.line), [9, 11, 12]);
});

test('SQLite execution without await is checked, and unrelated query builders stay clean', () => {
  const files = fixtures('sqlite-core');
  for (const [name, contents] of Object.entries(files)) files[name.replace('drizzle-orm/sqlite-core', 'custom-driver')] = contents;
  const findings = lint(`import type {Database} from 'drizzle-orm/sqlite-core/db';
import type {Database as Custom} from 'custom-driver/db';
function use(db: Database, other: Custom, ids: number[]) {
  for (const id of ids) {
    db.select().from('users').where({id}).run();
    other.select().from('users').where({id}).run();
    other.delete('users').execute();
  }
  db.delete('users').run();
}`, files);
  assert.deepEqual(findings.map(({line,ruleId}) => [line,ruleId]), [
    [5,'drizzle-query-in-loop'], [9,'drizzle-unfiltered-write'],
  ]);
});

test('async returns execute thenable writes and preserve synchronous builder factories', () => {
  const findings = lint(`import type {Database} from 'drizzle-orm/pg-core/db';
declare const db: Database;
async function clear() { return db.delete('jobs'); }
const reset = async () => db.update('jobs').set({active: false});
function build() { return db.delete('jobs'); }
async function prepare() { return db.delete('jobs').prepare('clear'); }
async function filtered() { return db.delete('jobs').where({id: 1}); }
async function* delayed() { return db.delete('jobs'); }
async function partial() { return db.update('jobs'); }
async function dynamic(value: boolean) { return db.update('jobs').set({active: value}); }
`, fixtures('pg-core'));
  assert.deepEqual(findings.map(({line, ruleId}) => [line, ruleId]),
    [3, 4, 10].map(line => [line, 'drizzle-unfiltered-write']));
  assert.match(findings[1].message, /same boolean/);
  assert.doesNotMatch(findings[0].message, /same boolean/);
  assert.doesNotMatch(findings[2].message, /same boolean/);
});

test('objects whose then is non-callable or only sometimes callable stay unverified on async return', () => {
  const files = fixtures('pg-core');
  files['node_modules/drizzle-orm/pg-core/db.d.ts'] = `export class Database {
    delete(table: string): {then: number};
    update(table: string): {set(input: object): Promise<void> | {then: number}};
  }`;
  assert.deepEqual(lint(`import type {Database} from 'drizzle-orm/pg-core/db';
    declare const db: Database;
    const build = async () => db.delete('jobs');
    const maybe = async () => db.update('jobs').set({active: true});`, files), []);
});

test('Drizzle handles empty predicate groups and only known SQL tautologies on the final WHERE', () => {
  const files = {
    ...fixtures('pg-core'),
    'node_modules/drizzle-orm/sql/expressions/conditions.d.ts': 'export function and(...parts: unknown[]): unknown; export function or(...parts: unknown[]): unknown;',
    'node_modules/drizzle-orm/sql/sql.d.ts': 'export function sql(parts: TemplateStringsArray, ...values: unknown[]): unknown;',
  };
  const findings = lint(`import type {Database} from 'drizzle-orm/pg-core/db';
import {and as every, or} from 'drizzle-orm/sql/expressions/conditions';
import {sql} from 'drizzle-orm/sql/sql';
declare function custom(...values: unknown[]): unknown;
async function work(db: Database, active: boolean) {
  await db.delete('users').where(every());
  await db.delete('users').where(every(or(undefined), void 0));
  await db.delete('users').where(sql\` 1 = 1 \`);
  await db.delete('users').where({id: 3}).where(undefined);
  await db.delete('users').where(every(undefined, {id: 3}));
  await db.delete('users').where(sql\`false\`);
  await db.delete('users').where(sql\`active = \${active}\`);
  await db.delete('users').where(custom());
  await db.delete('users').where(undefined).where({id: 3});
  db.delete('users').where(every()).prepare('reviewed');
  const lookup = db.select().from('users').prepare('lookup');
}`, files);
  assert.deepEqual(findings.map(({line,ruleId}) => [line,ruleId]),
    [6,7,8,9].map(line => [line,'drizzle-unfiltered-write']));
});
