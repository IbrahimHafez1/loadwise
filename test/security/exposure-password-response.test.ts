import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.js';
import { stubs } from './helpers.js';

const ruleId = 'password-hash-in-response';

const prismaClient = [
  'type User = { id: string; email: string; passwordHash: string };',
  'type Args = { where?: object; select?: object; omit?: object };',
  'declare const prisma: { user: { findUnique(args: Args): Promise<User | null>; findMany(args?: Args): Promise<User[]>;',
  '  create(args: Args & { data: object }): Promise<User> } };',
  'declare function toPublicUser(user: User): object;',
].join('\n');
const expressRoute = (body: string) =>
  `import express from 'express';\n${prismaClient}\nconst app = express();\napp.get('/me', async (req, res) => { ${body} });`;

const typeormStub = {
  'node_modules/typeorm/index.d.ts': [
    'export declare function Column(options?: object): PropertyDecorator;',
    'export declare class Repository<T> { findOneBy(where: object): Promise<T | null>;',
    '  findOne(options: object): Promise<T | null>; save(entity: T): Promise<T> }',
  ].join('\n'),
};
const classTransformerStub = {
  'node_modules/class-transformer/index.d.ts': 'export declare function Exclude(): PropertyDecorator;',
};
const nestController = (passwordDecorator: string, body: string) =>
  [
    "import { Controller, Get, Param } from '@nestjs/common';",
    "import { Column, Repository } from 'typeorm';",
    "import { Exclude } from 'class-transformer';",
    `class User { @Column() id: string; @Column() email: string; ${passwordDecorator} password: string }`,
    '@Controller() class UsersController {',
    '  constructor(private readonly users: Repository<User>) {}',
    `  @Get(':id') async find(@Param('id') id: string) { ${body} }`,
    '}',
  ].join('\n');
const nestFiles = { ...stubs.nest, ...typeormStub, ...classTransformerStub };

test('a Prisma record with its password hash sent from an Express handler is reported', () => {
  const bodies = [
    'const user = await prisma.user.findUnique({ where: { id: req.params.id } }); res.json(user);',
    'res.json(await prisma.user.findMany());',
    'const user = await prisma.user.findUnique({ where: {} }); res.status(200).json({ user });',
    'const user = await prisma.user.findUnique({ where: {} }); res.send({ ...user, ok: true });',
    'const user = await prisma.user.create({ data: req.body }); const payload = { user }; return res.json(payload);',
  ];
  for (const body of bodies) {
    const findings = defaultFindingsOf(ruleId, expressRoute(body), stubs.express);
    assert.equal(findings.length, 1, body);
    assert.match(findings[0].message, /`passwordHash`/);
  }
});

test('selected fields, sanitizers, deletes and destructuring are clean', () => {
  const bodies = [
    'const user = await prisma.user.findUnique({ where: {}, select: { id: true, email: true } }); res.json(user);',
    'const user = await prisma.user.findUnique({ where: {}, omit: { passwordHash: true } }); res.json(user);',
    'const user = await prisma.user.findUnique({ where: {} }); res.json(toPublicUser(user!));',
    'const user = await prisma.user.findUnique({ where: {} }); delete (user as any).passwordHash; res.json(user);',
    'const user = await prisma.user.findUnique({ where: {} }); const { passwordHash, ...rest } = user!; res.json(rest);',
    'const user = await prisma.user.findUnique({ where: {} }); res.json({ id: user!.id, email: user!.email });',
    'const user = await prisma.user.findUnique({ where: {} }); res.json({ ...user, passwordHash: undefined });',
    'const users = await prisma.user.findMany(); res.json(users.map((user) => ({ id: user.id })));',
    'const user = await prisma.user.findUnique({ where: {} }); res.json({ found: Boolean(user) });',
  ];
  for (const body of bodies) assert.equal(findingsOf(ruleId, expressRoute(body), stubs.express).length, 0, body);
});

test('a project helper that returns the record whole is followed; one that strips the hash is not', () => {
  const helpers = [
    'function envelope(user: User | null) { return { data: user }; }',
    'function strip(user: User) { const { passwordHash, ...rest } = user; return rest; }',
  ].join('\n');
  const route = (body: string) =>
    expressRoute(body).replace('const app = express();', `${helpers}\nconst app = express();`);
  const wrapped = 'const user = await prisma.user.findUnique({ where: {} }); res.json(envelope(user));';
  assert.equal(defaultFindingsOf(ruleId, route(wrapped), stubs.express).length, 1);
  const stripped = 'const user = await prisma.user.findUnique({ where: {} }); if (user) res.json(strip(user));';
  assert.deepEqual(findingsOf(ruleId, route(stripped), stubs.express), []);
});

test('a read outside a request handler is clean', () => {
  const source = `${prismaClient}\nexport async function loadUser() { return prisma.user.findUnique({ where: {} }); }`;
  assert.equal(findingsOf(ruleId, source).length, 0);
});

test('a TypeORM entity returned from a Nest controller is reported unless the column is hidden', () => {
  const reported = nestController('@Column()', 'return this.users.findOneBy({ id });');
  assert.equal(defaultFindingsOf(ruleId, reported, nestFiles).length, 1);
  const hiddenCases = [
    nestController('@Column({ select: false })', 'return this.users.findOneBy({ id });'),
    nestController('@Exclude() @Column()', 'return this.users.findOneBy({ id });'),
    nestController('@Column()', 'return this.users.findOne({ where: { id }, select: { id: true } });'),
  ];
  for (const source of hiddenCases) assert.equal(findingsOf(ruleId, source, nestFiles).length, 0, source);
});

test('a Next route handler returning the record through NextResponse.json is reported', () => {
  const source = [
    prismaClient,
    'declare const NextResponse: { json(body: unknown): Response };',
    'export async function GET(request: Request) {',
    '  const user = await prisma.user.findUnique({ where: {} });',
    '  return NextResponse.json(user);',
    '}',
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, source).length, 1);
});

test('a Mongoose read is clean when the projection or schema hides the password', () => {
  const mongooseStub = {
    'node_modules/mongoose/index.d.ts': [
      'export interface Query<T> extends Promise<T> { select(fields: string): Query<T>; lean(): Query<T> }',
      'export interface Model<T> { findById(id: string, projection?: string): Query<T | null> }',
    ].join('\n'),
  };
  const route = (schema: string, read: string) =>
    [
      "import express from 'express';",
      "import { Model } from 'mongoose';",
      'interface UserDocument { email: string; password: string }',
      'declare const User: Model<UserDocument>;',
      schema,
      'const app = express();',
      `app.get('/me', async (req, res) => { const user = await ${read}; res.json(user); });`,
    ].join('\n');
  const files = { ...stubs.express, ...mongooseStub };
  assert.equal(defaultFindingsOf(ruleId, route('', 'User.findById(req.params.id).lean()'), files).length, 1);
  const cleanCases = [
    route('', "User.findById(req.params.id).select('-password')"),
    route('', "User.findById(req.params.id, '-password')"),
    route('const schema = { password: { type: String, select: false } };', 'User.findById(req.params.id).lean()'),
  ];
  for (const source of cleanCases) assert.equal(findingsOf(ruleId, source, files).length, 0, source);
});

const nestServiceController = (serviceBody: string) =>
  [
    "import { Controller, Get, Param } from '@nestjs/common';",
    prismaClient,
    'class UsersService {',
    `  async findOne(id: string) { ${serviceBody} }`,
    '}',
    '@Controller() class UsersController {',
    '  constructor(private readonly users: UsersService) {}',
    "  @Get(':id') find(@Param('id') id: string) { return this.users.findOne(id); }",
    '}',
  ].join('\n');

test('a record returned whole by an injected service method is traced into the Nest controller response', () => {
  const bodies = [
    'return prisma.user.findUnique({ where: { id } });',
    'const user = await prisma.user.findUnique({ where: { id } }); return user;',
  ];
  for (const body of bodies) {
    const findings = defaultFindingsOf(ruleId, nestServiceController(body), stubs.nest);
    assert.equal(findings.length, 1, body);
    assert.match(findings[0].message, /`passwordHash`/);
  }
});

test('an injected service method that selects, omits or strips the password is clean', () => {
  const bodies = [
    'return prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });',
    'return prisma.user.findUnique({ where: { id }, omit: { passwordHash: true } });',
    'const user = await prisma.user.findUnique({ where: { id } }); const { passwordHash, ...rest } = user!; return rest;',
    'const user = await prisma.user.findUnique({ where: { id } }); return { id: user!.id };',
  ];
  for (const body of bodies) assert.deepEqual(findingsOf(ruleId, nestServiceController(body), stubs.nest), [], body);
});

test('a service that is not constructor-injected is not followed', () => {
  const source = nestServiceController('return prisma.user.findUnique({ where: { id } });').replace(
    'constructor(private readonly users: UsersService) {}',
    'users = new UsersService();',
  );
  assert.deepEqual(findingsOf(ruleId, source, stubs.nest), []);
});
