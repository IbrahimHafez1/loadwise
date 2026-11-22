'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const RULE_ID = 'orm-cartesian-include';
const files = {
  'node_modules/typeorm/index.d.ts': `export declare class SelectQueryBuilder<T> {
      leftJoinAndSelect(property: string, alias: string): this;
      innerJoinAndSelect(property: string, alias: string): this;
      leftJoin(property: string, alias: string): this;
      where(condition: string): this;
      getMany(): Promise<T[]>;
    }
    export declare class Repository<T> {
      createQueryBuilder(alias: string): SelectQueryBuilder<T>;
      find(options?: object): Promise<T[]>;
    }`,
  'node_modules/sequelize/index.d.ts': `export declare abstract class Model {
      static findAll(options?: object): Promise<Model[]>;
      static hasMany(target: unknown, options?: object): void;
    }`,
};
const header = `import { Repository } from 'typeorm';
import { Model } from 'sequelize';
class Comment { id!: number; }
class Tag { id!: number; }
class Profile { id!: number; }
class Post { id!: number; comments!: Comment[]; }
class User { id!: number; posts!: Post[]; tags!: Tag[]; profile!: Profile; }
declare const users: Repository<User>;
class Author extends Model { posts!: Post[]; tags!: Tag[]; profile!: Profile; }
`;

function findings(body) {
  return lint(header + body, files).filter((finding) => finding.ruleId === RULE_ID);
}

test('reports the second collection join of a TypeORM query builder', () => {
  const found = findings(`export const run = () => users.createQueryBuilder('user')
    .leftJoinAndSelect('user.posts', 'post')
    .leftJoinAndSelect('user.tags', 'tag')
    .getMany();`);
  assert.equal(found.length, 1);
  assert.equal(found[0].contextualReason, undefined);
  assert.match(found[0].message, /own query/);
});

test('reports a collection nested under a collection join', () => {
  assert.equal(
    findings(`export const run = () => users.createQueryBuilder('user')
      .leftJoinAndSelect('user.posts', 'post')
      .innerJoinAndSelect('post.comments', 'comment').getMany();`).length,
    1,
  );
});

test('accepts one collection plus to-one joins and non-selecting joins', () => {
  assert.deepEqual(
    findings(`export const run = () => users.createQueryBuilder('user')
      .leftJoinAndSelect('user.posts', 'post')
      .leftJoinAndSelect('user.profile', 'profile')
      .leftJoin('user.tags', 'tag').getMany();`),
    [],
  );
});

test('reports find relations with two collections as array and object', () => {
  assert.equal(
    findings(`export const a = () => users.find({ relations: ['posts', 'tags'] });
    export const b = () => users.find({ relations: { posts: { comments: true } } });
    export const c = () => users.find({ relations: { posts: true, tags: true } });`).length,
    3,
  );
});

test('accepts the query load strategy, one collection and unrelated find options', () => {
  assert.deepEqual(
    findings(`export const a = () => users.find({ relations: ['posts', 'tags'], relationLoadStrategy: 'query' });
    export const b = () => users.find({ relations: ['posts', 'profile'] });
    export const c = () => users.find({ where: { id: 1 } });`),
    [],
  );
});

test('reports Sequelize includes of two collection associations', () => {
  assert.equal(
    findings(`export const run = () => Author.findAll({ include: [{ model: Post }, { model: Tag }] });`).length,
    1,
  );
});

test('accepts separate includes, a single collection and to-one includes', () => {
  assert.deepEqual(
    findings(`export const a = () => Author.findAll({ include: [{ model: Post, separate: true }, { model: Tag }] });
    export const b = () => Author.findAll({ include: [Post, Profile] });
    export const c = () => Author.findAll({ include: [{ model: Post, separate: true }, { model: Tag, separate: true }] });`),
    [],
  );
});

test('ignores query builders and finds of other libraries', () => {
  assert.deepEqual(
    findings(`declare const other: { createQueryBuilder(alias: string): { leftJoinAndSelect(p: string, a: string): any } };
    declare const store: { find(options: object): void };
    export const run = () => {
      other.createQueryBuilder('user').leftJoinAndSelect('user.posts', 'p').leftJoinAndSelect('user.tags', 't');
      store.find({ relations: ['posts', 'tags'] });
    };`),
    [],
  );
});
