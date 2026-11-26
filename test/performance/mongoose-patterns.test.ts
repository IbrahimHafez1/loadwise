import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';

const mongooseTypes = `
  export declare class ObjectId { constructor(id?: string) }
  export declare namespace Types { export { ObjectId } }
  export interface Document { toObject(options?: object): object; toJSON(options?: object): object; save(): Promise<this>; fullName: string }
  export interface Query<T> extends PromiseLike<T> { lean(): Query<object>; select(fields: string): Query<T>; populate(path: string): Query<T> }
  export interface Model<T> {
    find(filter?: object): Query<Document[]>;
    findOne(filter?: object): Query<Document | null>;
    findById(id: string): Query<Document | null>;
    aggregate(pipeline: object[]): Promise<object[]>;
  }
  export declare function model<T>(name: string, schema: object): Model<T>;
`;

const sequelizeTypes = `
  export declare class Model {
    static findOne(options?: object): Promise<Model | null>;
    static aggregate(field: string, fn: string): Promise<number>;
    toJSON(): object;
  }
`;

const files = {
  'node_modules/mongoose/index.d.ts': mongooseTypes,
  'node_modules/sequelize/index.d.ts': sequelizeTypes,
};

function findings(source: string, extraFiles: FileMap, ruleId: string) {
  return lint(source, { ...files, ...extraFiles }).filter((finding: Finding) => finding.ruleId === ruleId);
}

function hydrate(source: string, extraFiles: FileMap = {}) {
  return findings(source, extraFiles, 'mongoose-hydrate-for-to-object');
}

function uncastId(source: string, extraFiles: FileMap = {}) {
  return findings(source, extraFiles, 'mongoose-aggregate-uncast-id');
}

const mongooseModel = "import { model, Types } from 'mongoose';\nconst User = model<object>('User', {});\n";

test('reports a findById result that is only null-checked and converted with toObject()', () => {
  const found = hydrate(
    mongooseModel +
      'export async function load(id: string) {\n  const user = await User.findById(id);\n  if (!user) return null;\n  return user.toObject();\n}',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 4);
});

test('reports an awaited findOne converted inline and a find mapped to toJSON()', () => {
  const found = hydrate(
    mongooseModel +
      'export async function load() {\n  const one = (await User.findOne({}))?.toJSON();\n  const all = (await User.find({})).map((doc) => doc.toJSON());\n  return { one, all };\n}',
  );
  assert.equal(found.length, 2);
});

test('reports through a select() chain', () => {
  const found = hydrate(
    mongooseModel +
      "export async function load(id: string) {\n  const user = await User.findById(id).select('name');\n  return user?.toObject();\n}",
  );
  assert.equal(found.length, 1);
});

test('stays quiet when the chain already calls lean()', () => {
  const found = hydrate(
    mongooseModel +
      "export async function load(id: string) {\n  const user: any = await User.findById(id).select('name').lean();\n  return user.toObject();\n}",
  );
  assert.deepEqual(found, []);
});

test('stays quiet when the document is used for more than the conversion', () => {
  const found = hydrate(
    mongooseModel +
      [
        'export async function save(id: string) {',
        '  const user = await User.findById(id);',
        '  if (!user) return null;',
        '  await user.save();',
        '  return user.toObject();',
        '}',
        'export async function virtuals(id: string) {',
        '  const user = await User.findById(id);',
        '  return { name: user?.fullName, plain: user?.toObject() };',
        '}',
        'export async function passed(id: string, audit: (doc: unknown) => void) {',
        '  const user = await User.findById(id);',
        '  audit(user);',
        '  return user?.toObject();',
        '}',
        'export async function withOptions(id: string) {',
        '  const user = await User.findById(id);',
        '  return user?.toObject({ virtuals: true });',
        '}',
      ].join('\n'),
  );
  assert.deepEqual(found, []);
});

test('stays quiet when the project customizes toJSON or toObject on a schema', () => {
  const found = hydrate(
    mongooseModel + 'export async function load(id: string) {\n  return (await User.findById(id))?.toJSON();\n}',
    { 'user.schema.ts': 'export const options = { toJSON: { transform: (_doc: object, ret: object) => ret } };' },
  );
  assert.deepEqual(found, []);
});

test('stays quiet for a Sequelize Model findOne converted with toJSON()', () => {
  const found = hydrate(
    [
      "import { Model } from 'sequelize';",
      'class User extends Model {}',
      'declare const Accounts: typeof Model;',
      'export async function load() {',
      '  const user = await User.findOne({});',
      '  const account = (await Accounts.findOne({}))?.toJSON();',
      '  return { account, user: user?.toJSON() };',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(found, []);
});

test('stays quiet for a project class whose type is named Model', () => {
  const found = hydrate(
    [
      'class Model { findOne(): Promise<{ toObject(): object } | null> { return Promise.resolve(null); } }',
      'const repository = new Model();',
      'export async function load() {',
      '  return (await repository.findOne())?.toObject();',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(found, []);
});

test('reports a string _id in an aggregate $match stage', () => {
  const found = uncastId(
    mongooseModel +
      "export async function load(id: string) {\n  return User.aggregate([{ $match: { _id: id } }, { $match: { _id: 'abc' } }]);\n}",
  );
  assert.equal(found.length, 2);
});

test('stays quiet for cast, union-typed, operator and Sequelize aggregate values', () => {
  const found = uncastId(
    mongooseModel +
      [
        "import { Model } from 'sequelize';",
        'class Order extends Model {}',
        'export async function load(id: string, either: string | Types.ObjectId) {',
        '  await User.aggregate([{ $match: { _id: new Types.ObjectId(id) } }]);',
        '  await User.aggregate([{ $match: { _id: either } }]);',
        '  await User.aggregate([{ $match: { _id: { $in: [id] } } }]);',
        "  await Order.aggregate('total', 'sum');",
        '}',
      ].join('\n'),
  );
  assert.deepEqual(found, []);
});

test('stays quiet when a schema declares a String _id', () => {
  const found = uncastId(
    mongooseModel + 'export async function load(id: string) {\n  return User.aggregate([{ $match: { _id: id } }]);\n}',
    { 'user.schema.ts': 'export const definition = { _id: { type: String, default: () => "uuid" } };' },
  );
  assert.deepEqual(found, []);
});

test('reports an untyped model(...) receiver when mongoose types are missing', () => {
  const found = lint(
    [
      "import { model } from 'mongoose';",
      "const User = model('User', {});",
      'export async function load(id: string) {',
      '  return User.aggregate([{ $match: { _id: id } }]);',
      '}',
    ].join('\n'),
  ).filter((finding: Finding) => finding.ruleId === 'mongoose-aggregate-uncast-id');
  assert.equal(found.length, 1);
});

test('treats ternary condition on a stored document as a presence check', () => {
  const found = hydrate(
    mongooseModel +
      'export async function load(id: string) {\n  const user = await User.findById(id);\n  return user ? user.toObject() : null;\n}',
  );
  assert.equal(found.length, 1);
});
