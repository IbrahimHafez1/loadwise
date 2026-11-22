'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const RULE_ID = 'orm-deep-offset';
const files = {
  'node_modules/@nestjs/common/index.d.ts': `export declare function Controller(path?: string): ClassDecorator;
    export declare function Get(path?: string): MethodDecorator;
    export declare function Query(name?: string): ParameterDecorator;
    export declare function Injectable(): ClassDecorator;`,
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate {
      findMany(args?: object): Promise<{ id: number }[]>;
    }
    export declare class PrismaClient { user: UserDelegate }`,
  'node_modules/mongoose/index.d.ts': `export declare class Query<T> { skip(count: number): this; limit(count: number): this; }
    export declare class Model<T> { find(filter?: object): Query<T[]>; }`,
};
const header = `import { Controller, Get, Query, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Model } from 'mongoose';
declare const prisma: PrismaClient, users: Model<{ id: number }>;
declare const response: { json(value: unknown): void };
`;

function findings(body) {
  return lint(header + body, files).filter((finding) => finding.ruleId === RULE_ID);
}

test('reports a Prisma skip computed from the query string in an Express handler', () => {
  const [finding] = findings(`export async function list(req: { query: { page?: string } }, res: typeof response) {
    const page = Number(req.query.page) || 1;
    res.json(await prisma.user.findMany({ skip: (page - 1) * 20, take: 20 }));
  }`);
  assert.ok(finding);
  assert.equal(finding.contextualReason, undefined);
  assert.match(finding.message, /cursor/);
});

test('reports a Nest query parameter feeding a Mongoose skip and a decorated object parameter', () => {
  const found = findings(`@Controller('users') export class UsersController {
    @Get() a(@Query('offset') offset: string) { return users.find().skip(Number(offset)).limit(20); }
    @Get('b') b(@Query() query: { page: number }) { return prisma.user.findMany({ skip: query.page * 20 }); }
  }`);
  assert.equal(found.length, 2);
});

test('reports a literal offset above the threshold anywhere', () => {
  assert.equal(findings('export const rows = () => prisma.user.findMany({ skip: 50000, take: 10 });').length, 1);
});

test('accepts Math.min, an upper-bound comparison, a small literal and non-request offsets', () => {
  assert.deepEqual(
    findings(`export async function a(req: { query: { page?: string } }, res: typeof response) {
      const page = Math.min(Number(req.query.page) || 1, 100);
      res.json(await prisma.user.findMany({ skip: (page - 1) * 20 }));
    }
    export async function b(req: { query: { page?: string } }, res: typeof response) {
      const page = Number(req.query.page) || 1;
      if (page > 500) throw new Error('page too deep');
      res.json(await prisma.user.findMany({ skip: page * 20 }));
    }
    export async function c(req: unknown, res: typeof response) {
      res.json(await prisma.user.findMany({ skip: 1, take: 20 }));
    }
    export async function d(req: unknown, res: typeof response, offset: number) {
      res.json(await prisma.user.findMany({ skip: offset }));
    }
    export async function e(req: { query: { page?: string } }, res: typeof response) {
      let page = Number(req.query.page) || 1;
      page = Math.min(page, 100);
      res.json(await prisma.user.findMany({ skip: page * 20 }));
    }`),
    [],
  );
});

test('accepts a field capped by a schema declared in the same file', () => {
  assert.deepEqual(
    findings(`declare const number: () => { max(limit: number): number };
    const schema = { page: number().max(100) };
    declare const validator: { parse(input: unknown): { page: number } };
    export async function list(req: { query: unknown }, res: typeof response) {
      const { page } = validator.parse(req.query);
      res.json(await prisma.user.findMany({ skip: page * 20 }));
    }`),
    [],
  );
});

test('reports a service method one hop away as contextual', () => {
  const [finding] = findings(`@Injectable() class UsersService {
    list(page: number) { return prisma.user.findMany({ skip: page * 20, take: 20 }); }
  }
  declare const service: UsersService;
  @Controller('users') export class UsersController {
    @Get() list(@Query('page') page: string) { return service.list(Number(page)); }
  }`);
  assert.ok(finding);
  assert.ok(finding.contextualReason);
});
