'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const typeormStub = `export class Repository<T> {
  find(options?: object): Promise<T[]>;
  findBy(filter: object): Promise<T[]>;
  findOne(options: object): Promise<T | null>;
  findOneBy(filter: object): Promise<T | null>;
  exists(options?: object): Promise<boolean>;
  existsBy(filter: object): Promise<boolean>;
  count(options?: object): Promise<number>;
  countBy(filter: object): Promise<number>;
}
export function Column(typeOrOptions?: unknown, options?: object): PropertyDecorator;
export function PrimaryGeneratedColumn(type?: string): PropertyDecorator;
export function Entity(name?: string): ClassDecorator;`;
const sequelizeStub = `export class Model {
  static findAll(options?: object): Promise<Model[]>;
  static count(options?: object): Promise<number>;
}`;

function fixesFor(context, source, ruleId) {
  const { findings } = scanWithFixes(context, {
    'node_modules/typeorm/index.d.ts': typeormStub,
    'node_modules/sequelize/index.d.ts': sequelizeStub,
    'src/service.ts': source,
  });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

test('existence read becomes exists/existsBy with the same argument', (context) => {
  const [inline, direct] = fixesFor(
    context,
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
export async function check() {
  if (await repo.findOne({ where: { id: 1 } })) return 1;
  return !(await repo.findOneBy({ id: 2 }));
}`,
    'typeorm-existence-materialization',
  );
  assert.deepEqual(onlyChange(inline), {
    before: 'if (await repo.findOne({ where: { id: 1 } })) return 1;',
    after: "if (await repo[typeof repo.exists === 'function' ? 'exists' : 'findOne']({ where: { id: 1 } })) return 1;",
  });
  assert.deepEqual(onlyChange(direct), {
    before: 'return !(await repo.findOneBy({ id: 2 }));',
    after: "return !(await repo[typeof repo.existsBy === 'function' ? 'existsBy' : 'findOneBy']({ id: 2 }));",
  });
});

test('existence read bound to a variable only tested by the next guard is rewritten', (context) => {
  const [finding] = fixesFor(
    context,
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
export async function check() {
  const found = await repo.findOneBy({ id: 5 });
  if (!found) return;
}`,
    'typeorm-existence-materialization',
  );
  assert.deepEqual(onlyChange(finding), {
    before: 'const found = await repo.findOneBy({ id: 5 });',
    after: "const found = await repo[typeof repo.existsBy === 'function' ? 'existsBy' : 'findOneBy']({ id: 5 });",
  });
});

test('existence read whose entity is used or not flagged gets no site fix', (context) => {
  const findings = fixesFor(
    context,
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
export async function check() {
  const found = await repo.findOneBy({ id: 5 });
  if (found) return found;
}`,
    'typeorm-existence-materialization',
  );
  assert.deepEqual(findings, []);
});

test('guarded existence query uses one call with the same receiver and evaluates its filter once', async (context) => {
  const source = `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
declare function filter(): object;
async function present() {
  const found = await repo.findOne({ where: { id: filter() } });
  return found != null;
}`;
  const [finding] = fixesFor(context, source, 'typeorm-existence-materialization');
  assert.equal(finding.fix.requiresReview, true);
  const rewritten = finding.fix.changes.reduce(
    (text, change) => text.replace(change.before, () => change.after),
    source,
  );
  const run = new Function(
    'repo',
    'filter',
    rewritten.slice(rewritten.indexOf('async function present')) + ';return present();',
  );
  for (const [fast, value, expected] of [
    [true, false, false],
    [true, true, true],
    [false, {}, true],
    [false, null, false],
    [false, undefined, false],
  ]) {
    let argumentsBuilt = 0;
    let calls = 0;
    const repository = {
      [fast ? 'exists' : 'findOne'](argument) {
        assert.equal(this, repository);
        assert.deepEqual(argument, { where: { id: 'scope' } });
        calls++;
        return Promise.resolve(value);
      },
    };
    assert.equal(
      await run(repository, () => {
        argumentsBuilt++;
        return 'scope';
      }),
      expected,
    );
    assert.equal(argumentsBuilt, 1);
    assert.equal(calls, 1);
  }
});

test('repeatable-looking getters and factory-call receivers do not receive method dispatch edits', (context) => {
  const diagnostics = fixesFor(
    context,
    `import { Repository } from 'typeorm';
declare function acquire(): Repository<object>;
class Client {
  get repo() { return acquire(); }
  async load() {
    if (await acquire().findOne({ where: { id: 1 } })) return true;
    if (await this.repo.findOne({ where: { id: 2 } })) return true;
  }
}`,
    'typeorm-existence-materialization',
  );
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((finding) => !finding.fix));
});

test('wide projection adds select to the options object or creates it for a bare find', (context) => {
  const schema = `import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';
@Entity() class Row {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar' }) name!: string;
  @Column('jsonb') payload!: object;
}
declare const repo: Repository<Row>;
`;
  const [withWhere, bare, emptyOptions] = fixesFor(
    context,
    `${schema}export async function a() {
  const rows = await repo.find({ where: { id: 'x' } });
  return rows.map((row) => ({ id: row.id, name: row.name }));
}
export async function b() {
  return (await repo.find()).map((row) => ({ id: row.id }));
}
export async function c() {
  const rows = await repo.find({});
  return rows.map((row) => ({ id: row.id }));
}`,
    'typeorm-wide-projection',
  );
  assert.deepEqual(onlyChange(withWhere), {
    before: "const rows = await repo.find({ where: { id: 'x' } });",
    after: "const rows = await repo.find({ where: { id: 'x' }, select: { id: true, name: true } });",
  });
  assert.deepEqual(onlyChange(bare), {
    before: 'return (await repo.find()).map((row) => ({ id: row.id }));',
    after: 'return (await repo.find({ select: { id: true } })).map((row) => ({ id: row.id }));',
  });
  assert.deepEqual(onlyChange(emptyOptions), {
    before: 'const rows = await repo.find({});',
    after: 'const rows = await repo.find({ select: { id: true } });',
  });
});

test('wide projection on a multi-line options object adds select on its own line', (context) => {
  const [noComma, trailingComma] = fixesFor(
    context,
    `import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';
@Entity() class Row {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('jsonb') payload!: object;
}
declare const repo: Repository<Row>;
export async function a() {
  const rows = await repo.find({
    where: { id: 'x' }
  });
  return rows.map((row) => ({ id: row.id }));
}
export async function b() {
  const rows = await repo.find({
    where: { id: 'x' },
  });
  return rows.map((row) => ({ id: row.id }));
}`,
    'typeorm-wide-projection',
  );
  assert.deepEqual(onlyChange(noComma), {
    before: "where: { id: 'x' }",
    after: "where: { id: 'x' },\nselect: { id: true }",
  });
  assert.deepEqual(onlyChange(trailingComma), {
    before: "where: { id: 'x' },",
    after: "where: { id: 'x' },\nselect: { id: true },",
  });
});

test('count materialization becomes count/countBy and keeps parentheses where needed', (context) => {
  const findings = fixesFor(
    context,
    `import { Repository } from 'typeorm';
import { Model } from 'sequelize';
declare const repo: Repository<object>;
export async function counts() {
  const total = (await repo.find({ where: { active: true } })).length;
  const byId = (await repo.findBy({ id: 1 })).length;
  const everything = (await repo.find()).length + 1;
  const people = (await Model.findAll({ where: { city: 'x' } })).length;
  return total + byId + everything + people;
}`,
    'orm-count-materialization',
  );
  assert.deepEqual(findings.map(onlyChange), [
    {
      before: 'const total = (await repo.find({ where: { active: true } })).length;',
      after: 'const total = await repo.count({ where: { active: true } });',
    },
    {
      before: 'const byId = (await repo.findBy({ id: 1 })).length;',
      after: 'const byId = await repo.countBy({ id: 1 });',
    },
    {
      before: 'const everything = (await repo.find()).length + 1;',
      after: 'const everything = (await repo.count()) + 1;',
    },
    {
      before: "const people = (await Model.findAll({ where: { city: 'x' } })).length;",
      after: "const people = await Model.count({ where: { city: 'x' } });",
    },
  ]);
});

test('count materialization is left to the generic example for mongoose-style queries', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/mongoose/index.d.ts': `export class Query<T> implements PromiseLike<T> {
  exec(): Promise<T>;
  then: Promise<T>['then'];
  lean(): Query<T>;
}
export interface Model<T> { find(filter?: object): Query<T[]>; }`,
    'src/service.ts': `import type { Model } from 'mongoose';
declare const users: Model<object>;
export async function total() { return (await users.find({ active: true })).length; }`,
  });
  const counting = findings.filter((finding) => finding.ruleId === 'orm-count-materialization');
  assert.equal(counting.length, 1);
  assert.equal(counting[0].fix, undefined);
});

test('existence read tested by a next-statement return is rewritten, nullish comparisons collapse to the boolean', (context) => {
  const findings = fixesFor(
    context,
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
export async function negated() {
  const found = await repo.findOneBy({ id: 1 });
  return !!found;
}
export async function wrapped() {
  const found = await repo.findOneBy({ id: 2 });
  return Boolean(found);
}
export async function notNull() {
  const found = await repo.findOneBy({ id: 3 });
  return found !== null;
}
export async function notUndefined() {
  const found = await repo.findOneBy({ id: 4 });
  return found !== undefined;
}
export async function looseNull() {
  const found = await repo.findOneBy({ id: 5 });
  return found != null;
}`,
    'typeorm-existence-materialization',
  );
  assert.equal(findings.length, 5);
  const rewritten = findings.map((finding) => finding.fix?.changes.map((change) => change.after).join('\n'));
  assert.match(rewritten[0], /'existsBy' : 'findOneBy'\]\(\{ id: 1 \}\)/);
  assert.match(rewritten[1], /'existsBy' : 'findOneBy'\]\(\{ id: 2 \}\)/);
  assert.equal(rewritten[2], undefined);
  assert.equal(rewritten[3], undefined);
  assert.match(rewritten[4], /return !!found;/);
});

test('existence read whose entity is used after the next-statement return test gets no site fix', (context) => {
  const findings = fixesFor(
    context,
    `import { Repository } from 'typeorm';
declare const repo: Repository<object>;
export async function check() {
  const found = await repo.findOneBy({ id: 5 });
  if (found !== null) log(found);
  return found != null;
}
declare function log(value: unknown): void;`,
    'typeorm-existence-materialization',
  );
  assert.deepEqual(findings, []);
});
