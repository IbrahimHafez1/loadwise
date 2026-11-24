import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf } from './exposure-helpers.cjs';
import { lint, lintWithoutTypes, stubs } from './helpers.cjs';
import type { LocatedFinding } from '../types/security.cjs';

const ruleId = 'mass-assignment';

function contextualFindingsOf(rule: string, source: string, files: Record<string, string>) {
  const findings = findingsOf(rule, source, files);
  assert.ok(findings.every(({ contextualReason }) => contextualReason));
  return findings;
}
const typeormStub = {
  'node_modules/typeorm/index.d.ts': [
    'export declare class Repository<T> { save(entity: object): Promise<T>; update(id: string, values: object): Promise<void>;',
    '  create(values: object): T; insert(values: object): Promise<void> }',
  ].join('\n'),
};
const mongooseStub = {
  'node_modules/mongoose/index.d.ts': [
    'export declare class Document { set(values: object): this }',
    'export interface Model<T> { new (values?: object): Document; create(values: object): Promise<unknown>;',
    '  findByIdAndUpdate(id: string, values: object): Promise<unknown> }',
  ].join('\n'),
};
const sequelizeStub = {
  'node_modules/sequelize/index.d.ts':
    'export declare class Model { static create(values: object, options?: object): Promise<unknown>; static update(values: object, options: object): Promise<unknown> }',
};
const expressRoute = (body: string, preamble = '') =>
  `import express from 'express';\n${preamble}\nconst app = express();\napp.post('/items', async (req, res) => { ${body} });`;

test('Prisma writes of the whole request body are reported, with and without types', () => {
  const bodies = [
    'await prisma.user.create({ data: req.body });',
    'await prisma.user.update({ where: { id: 1 }, data: { ...req.body } });',
    'const body = req.body; await prisma.user.updateMany({ data: body });',
    'await this_.prisma.post.upsert({ where: { id: 1 }, create: req.body, update: req.body });',
    'await prisma.user.createMany({ data: req.body });',
  ];
  for (const body of bodies) {
    const source = expressRoute(body, 'declare const prisma: any; declare const this_: any;');
    assert.ok(contextualFindingsOf(ruleId, source, stubs.express).length >= 1, body);
    assert.ok(
      lintWithoutTypes(source).some((finding: LocatedFinding) => finding.ruleId === ruleId),
      body,
    );
  }
});

test('explicit picks, single fields, validated results and other Prisma shapes are clean', () => {
  const bodies = [
    'await prisma.user.create({ data: { name: req.body.name, email: req.body.email } });',
    'await prisma.user.create({ data: { name: req.body.name, ...rest } });',
    'const { name } = req.body; await prisma.user.create({ data: { name } });',
    'await prisma.user.create({ data: schema.parse(req.body) });',
    'await prisma.user.create({ data: pick(req.body, ["name"]) });',
    'await prisma.user.create({ data: req.user });',
    'await prisma.user.findMany({ where: req.body });',
    'await prisma.user.create(req.body);',
  ];
  for (const body of bodies) {
    const source = expressRoute(
      body,
      'declare const prisma: any; declare const rest: object; declare const schema: any; declare function pick(o: object, k: string[]): object;',
    );
    assert.equal(findingsOf(ruleId, source, stubs.express).length, 0, body);
  }
});

const nestController = (dtoType: string, body: string, declarations = '') =>
  [
    "import { Controller, Post, Body } from '@nestjs/common';",
    declarations,
    'declare const prisma: any;',
    `@Controller() class ItemsController { @Post() create(@Body() dto: ${dtoType}) { ${body} } }`,
  ].join('\n');

test('a NestJS body typed any, an interface, an alias or an undecorated class is reported', () => {
  const declarations = [
    'interface CreateItem { name: string }',
    'type ItemInput = { name: string };',
    'class PlainDto { name: string }',
  ].join('\n');
  for (const type of ['any', 'CreateItem', 'ItemInput', 'Record<string, unknown>', 'PlainDto']) {
    const source = nestController(type, 'return prisma.item.create({ data: dto });', declarations);
    assert.equal(contextualFindingsOf(ruleId, source, stubs.nest).length, 1, type);
  }
});

test('a NestJS body typed with a validated DTO class is clean', () => {
  const declarations = [
    "import { IsString } from 'class-validator';",
    'class CreateItemDto { @IsString() name: string }',
    'class UpdateItemDto extends CreateItemDto {}',
    'declare function PartialType<T>(type: T): T;',
    'class PartialItemDto extends PartialType(CreateItemDto) {}',
  ].join('\n');
  for (const type of ['CreateItemDto', 'UpdateItemDto', 'PartialItemDto']) {
    const source = nestController(type, 'return prisma.item.create({ data: dto });', declarations);
    assert.equal(findingsOf(ruleId, source, stubs.nest).length, 0, type);
  }
});

test('a body passed through a service is contextual at one or two hops', () => {
  const service = (name: string, body: string) =>
    `class ${name} { constructor(private readonly prisma: any) {} ${body} }`;
  const oneHop = [
    "import { Controller, Post, Body } from '@nestjs/common';",
    service('ItemsService', 'create(data: any) { return this.prisma.item.create({ data }); }'),
    '@Controller() class ItemsController { constructor(private readonly items: ItemsService) {}',
    '  @Post() create(@Body() dto: any) { return this.items.create(dto); } }',
  ].join('\n');
  assert.equal(contextualFindingsOf(ruleId, oneHop, stubs.nest).length, 1);
  const twoHops = [
    "import { Controller, Post, Body } from '@nestjs/common';",
    service('Store', 'save(data: any) { return this.prisma.item.create({ data }); }'),
    'class ItemsService { constructor(private readonly store: Store) {} create(data: any) { return this.store.save(data); } }',
    '@Controller() class ItemsController { constructor(private readonly items: ItemsService) {}',
    '  @Post() create(@Body() dto: any) { return this.items.create(dto); } }',
  ].join('\n');
  const findings = findingsOf(ruleId, twoHops, stubs.nest);
  assert.equal(findings.length, 1);
  assert.match(findings[0].contextualReason ?? '', /two calls/);
});

test('TypeORM, Mongoose and Sequelize writes of the whole body are reported when the library is recognised', () => {
  const typeorm = expressRoute(
    'await repository.save(req.body); await repository.update("1", req.body);',
    "import { Repository } from 'typeorm';\ndeclare const repository: Repository<object>;",
  );
  assert.equal(contextualFindingsOf(ruleId, typeorm, { ...stubs.express, ...typeormStub }).length, 2);
  assert.equal(
    lintWithoutTypes(typeorm, { ...stubs.express, ...typeormStub }).filter((f) => f.ruleId === ruleId).length,
    2,
  );

  const mongoose = expressRoute(
    'await User.create(req.body); await User.findByIdAndUpdate("1", req.body); new User(req.body);',
    "import { Model } from 'mongoose';\ndeclare const User: Model<{ name: string }>;",
  );
  assert.equal(contextualFindingsOf(ruleId, mongoose, { ...stubs.express, ...mongooseStub }).length, 3);

  const sequelize = expressRoute(
    'await Item.create(req.body);',
    "import { Model } from 'sequelize';\ndeclare const Item: typeof Model;",
  );
  assert.equal(contextualFindingsOf(ruleId, sequelize, { ...stubs.express, ...sequelizeStub }).length, 1);
});

test('Mongoose documents assigned or set from the whole body are reported', () => {
  const source = expressRoute(
    'Object.assign(doc, req.body); doc.set(req.body);',
    "import { Document } from 'mongoose';\ndeclare const doc: Document;",
  );
  assert.equal(contextualFindingsOf(ruleId, source, { ...stubs.express, ...mongooseStub }).length, 2);
});

test('field picks, a fields option, a schema parse and unrecognised receivers are clean', () => {
  const sequelizeFields = expressRoute(
    'await Item.create(req.body, { fields: ["name"] });',
    "import { Model } from 'sequelize';\ndeclare const Item: typeof Model;",
  );
  assert.equal(findingsOf(ruleId, sequelizeFields, { ...stubs.express, ...sequelizeStub }).length, 0);
  const picked = expressRoute(
    'await repository.save({ name: req.body.name });',
    "import { Repository } from 'typeorm';\ndeclare const repository: Repository<object>;",
  );
  assert.equal(findingsOf(ruleId, picked, { ...stubs.express, ...typeormStub }).length, 0);
  const unknownReceiver = expressRoute(
    'await cache.save(req.body); await Map_.create(req.body);',
    'declare const cache: any; declare const Map_: any;',
  );
  assert.equal(findingsOf(ruleId, unknownReceiver, stubs.express).length, 0);
  const parsed = expressRoute(
    'await repository.save(schema.parse(req.body));',
    "import { Repository } from 'typeorm';\ndeclare const repository: Repository<object>;\ndeclare const schema: any;",
  );
  assert.equal(findingsOf(ruleId, parsed, { ...stubs.express, ...typeormStub }).length, 0);
});

test('a body parsed by a zod object schema is clean, also through a service call', () => {
  const schema =
    "import { z } from 'zod';\nconst Schema = z.object({ name: z.string() });\ndeclare const prisma: any;\n";
  const direct = expressRoute('const dto = Schema.parse(req.body); await prisma.item.create({ data: dto });', schema);
  assert.equal(findingsOf(ruleId, direct, stubs.express).length, 0);
  const viaService = expressRoute(
    'await save(Schema.parse(req.body));',
    `${schema}async function save(data: object) { await prisma.item.create({ data }); }`,
  );
  assert.equal(findingsOf(ruleId, viaService, stubs.express).length, 0);
});

test('a tRPC input is clean', () => {
  const source = [
    'declare const t: any; declare const prisma: any; declare const schema: unknown;',
    'export const create = t.procedure.input(schema).mutation(({ input }: any) => prisma.item.create({ data: input }));',
  ].join('\n');
  assert.equal(findingsOf(ruleId, source).length, 0);
});

test('the message and the typed run agree with the untyped run', () => {
  const source = expressRoute('await prisma.user.create({ data: req.body });', 'declare const prisma: any;');
  const [finding] = lint(source, stubs.express).filter((candidate) => candidate.ruleId === ruleId);
  assert.match(finding.message, /^The whole request body is written to the database/);
});
