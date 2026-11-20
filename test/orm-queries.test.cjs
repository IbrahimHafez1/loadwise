'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const repository = `export class Repository<T> {
  find(options?: object): Promise<T[]>;
  findBy(filter: object): Promise<T[]>;
  findOneBy(filter: object): Promise<T | null>;
}`;
const sequelizeModel = `export class Model {
  static findAll(options?: object): Promise<Model[]>;
  static findByPk(id: number): Promise<Model | null>;
}`;
const mongoose = `export class Query<T> implements PromiseLike<T> {
  exec(): Promise<T>;
  then: Promise<T>['then'];
  lean(): Query<T>;
  limit(n: number): Query<T>;
}
export interface Model<T> { find(filter?: object): Query<T[]>; findById(id: number): Query<T | null>; }`;
const files = {
  'node_modules/typeorm/index.d.ts': repository,
  'node_modules/sequelize/index.d.ts': sequelizeModel,
  'node_modules/@sequelize/core/index.d.ts': `declare class ModelTypeScript { static findByPk(id: number): Promise<Model | null> }
    export class Model extends ModelTypeScript { static findAll(options?: object): Promise<Model[]> }`,
  'node_modules/mongoose/index.d.ts': mongoose,
  'node_modules/knex/index.d.ts': `export interface Knex { (table: string): QueryBuilder }
    interface QueryInterface {
      select(field: string): QueryBuilder; where(field: string, value: number): QueryBuilder;
      limit(n: number): QueryBuilder; toSQL(): object;
    }
    interface QueryBuilder extends QueryInterface, PromiseLike<object[]> {}`,
  'node_modules/kysely/index.d.ts': `export class QueryCreator { selectFrom(table: string): SelectQueryBuilder }
    export class Kysely extends QueryCreator {}
    interface SelectQueryBuilder {
      selectAll(): SelectQueryBuilder; where(name: string, op: string, value: number): SelectQueryBuilder;
      limit(n: number): SelectQueryBuilder; execute(): Promise<object[]>; executeTakeFirst(): Promise<object>; compile(): object;
    }`,
};

test('existence-only TypeORM reads require direct truthiness, compatible repository methods and equivalent options', () => {
  const source = `import { Repository } from 'typeorm';
    declare const repo: Repository<object>, enabled: boolean, scope: { id: number };
    async function check() {
      if (enabled && !(await repo.findOne({ where: { id: 1 } }))) return; // exists
      return !(await repo.findOneBy({ id: 1 })); // exists
    }
    async function skip() {
      if (await repo.findOne({ where: scope, lock: { mode: 'pessimistic_read' } })) return;
      if (await repo.findOne({ where: scope, select: { id: true } })) return;
      if (await repo.findOne({ where: undefined })) return;
      const entity = await repo.findOneBy({id: 2});
      return (await repo.findOneBy(scope)) || entity;
    }
    async function duplicate() {
      const found = await repo.findOne({where: {id: 5}}); // exists
      if (found) throw Error();
    }
    async function usesRow() {
      const found = await repo.findOneBy({id: 5});
      if (found) return found;
    }
    async function captured() {
      const found = await repo.findOneBy({id: 5});
      if (!found) return;
      return () => found;
    }
    async function asserted() {
      if ((await repo.findOneBy({id:1})) as object) return;
      if (await (repo.findOneBy({id:1}) as Promise<object>)) return;
    }`;
  const declarations = `export class Repository<T> {
    findOne(options: object): Promise<T | null>; findOneBy(filter: object): Promise<T | null>;
  }`;
  const scan = (declaration) =>
    lint(source, { 'node_modules/typeorm/index.d.ts': declaration })
      .filter((finding) => finding.ruleId === 'typeorm-existence-materialization')
      .map((finding) => finding.line);
  assert.deepEqual(scan(declarations), []);
  assert.deepEqual(
    scan(
      declarations.replace(
        '}',
        'exists(options: object):Promise<boolean>; existsBy(filter: object):Promise<boolean>; }',
      ),
    ),
    [4, 5, 15],
  );
});

test('TypeORM recognizes In on the current batch while preserving per-record and custom predicates', () => {
  const source = `import {Repository, In as among} from 'typeorm';
    declare const repo: Repository<{id: number}>, groups: number[][];
    declare function custom(ids: number[]): object;
    async function check() {
      for (const page of groups) {
        await repo.find({ where: { id: among(page) } });
        await repo.findBy({ id: custom(page) });
        for (const id of page) await repo.findBy({ id, scope: among(page) });
      }
    }`;
  const declarations = {
    ...files,
    'node_modules/typeorm/index.d.ts': repository + 'export function In(ids: number[]): object;',
  };
  assert.deepEqual(
    lint(source, declarations)
      .filter((finding) => finding.ruleId === 'orm-query-in-loop')
      .map((finding) => finding.line),
    [7, 8],
  );
});

function assertMarked(source) {
  const expectations = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (line.endsWith('// loop')) expectations.push([index + 1, 'orm-query-in-loop']);
    if (line.endsWith('// count')) expectations.push([index + 1, 'orm-count-materialization']);
  }
  assert.deepEqual(
    lint(source, files)
      .filter((finding) => finding.ruleId.startsWith('orm-'))
      .map(({ line, ruleId }) => [line, ruleId]),
    expectations,
  );
}

test('discarded ORM counts do not recommend a replacement database query', () => {
  assertMarked(`import type {Repository} from 'typeorm';
    async function count(repo: Repository<object>) {
      void (await repo.find()).length;
      ((await repo.find()).length, 1);
      return (0, (await repo.find()).length); // count
    }`);
});

test('identifies eager Repository and inherited Sequelize Model reads using declaration provenance', () => {
  assertMarked(`
    import {Repository} from 'typeorm';
    import {Model} from 'sequelize';
    import {Model as NewModel} from '@sequelize/core';
    class Person extends Model {}
    class Record extends NewModel {}
    declare const users: Repository<{id: number}>;
    declare const other: { findOneBy(filter: object): unknown; findAll(): Promise<number[]>; };
    async function fetch(ids: number[]) {
      for (const id of ids) {
        users.findOneBy({id}); // loop
        await Person.findByPk(id); // loop
        await Record.findByPk(id); // loop
        await other.findOneBy({id});
      }
      const total = (await users.find({where: {id: 1}})).length; // count
      const byId = (await users.findBy({id: 1})).length; // count
      const count = (await Person.findAll()).length; // count
      const page = (await users.find({take: 5})).length;
      const groups = (await Person.findAll({group: ['city']})).length;
      const otherCount = (await other.findAll()).length;
      (await users.find()).length = 0;
    }`);
});

test('counts Mongoose executions but skips lazy builders, opaque options and arbitrary thenables', () => {
  assertMarked(`
    import type {Model, Query} from 'mongoose';
    declare const users: Model<{id:number}>, deferred: Query<unknown>;
    declare const fake: { find(): Query<unknown[]> };
    async function fetch(ids: number[]) {
      for (const id of ids) {
        users.findById(id);
        const queued = users.find({id}).lean();
        await users.findById(id); // loop
        await users.find({id}).lean(); // loop
        await users.find({id}).limit(1).exec(); // loop
        users.findById(id).then(() => {}); // loop
        deferred.exec(); // loop
      }
      ids.map(id => users.findById(id));
      Promise.all(ids.map(id => users.findById(id))); // loop
      ids.map(async id => users.findById(id)); // loop
      const direct = (await users.find({active:true})).length; // count
      const lean = (await users.find().lean().exec()).length; // count
      const firstPage = (await users.find().limit(5).lean().exec()).length;
      const geospatial = (await users.find({loc: {$near: [2,3]}})).length;
      const unknown = (await fake.find().lean().exec()).length;
    }`);
});

test('recognizes consumed Knex builders and Kysely select execution while leaving built queries alone', () => {
  assertMarked(`
    import type {Knex} from 'knex';
    import type {Kysely} from 'kysely';
    declare const knex: Knex, kysely: Kysely;
    async function fetch(ids: number[]) {
      for (const id of ids) {
        knex('people').where('id', id);
        await knex('people').where('id', id); // loop
        await knex('people'); // loop
        knex('people').select('id').then(() => {}); // loop
        knex('people').where('id', id).toSQL();
        const query = kysely.selectFrom('people').selectAll().where('id', '=', id);
        query.compile();
        query.executeTakeFirst(); // loop
        await query.execute(); // loop
      }
      const knexCount = (await knex('people').where('id', 1).select('id')).length; // count
      const kyselyCount = (await kysely.selectFrom('people').selectAll().where('id', '=', 1).execute()).length; // count
      const page = (await kysely.selectFrom('people').selectAll().limit(3).execute()).length;
      const limited = (await knex('people').limit(1).select('id')).length;
    }`);
});
