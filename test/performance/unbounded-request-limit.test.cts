import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';

import { typeorm } from './fixtures/schema/orm-stubs.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const RULE_ID = 'unbounded-list-query';
const typeormTypes = `${typeorm['node_modules/typeorm/index.d.ts']}
export declare class SelectQueryBuilder<T> { take(count: number): this; limit(count: number): this; }
export interface Repository<T> { createQueryBuilder(alias?: string): SelectQueryBuilder<T> }`;
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
  'node_modules/mongoose/index.d.ts': `export declare class Query<T> { limit(count: number): this; }
    export declare class Model<T> { find(filter?: object): Query<T[]>; }`,
  ...typeorm,
  'node_modules/typeorm/index.d.ts': typeormTypes,
  'node_modules/knex/index.d.ts': 'export declare class QueryBuilder { limit(count: number): this; }',
  'node_modules/drizzle-orm/index.d.ts': 'export declare class Select { limit(count: number): this; }',
  'node_modules/sequelize/index.d.ts':
    'export declare class Model { static findAll(options?: object): Promise<Model[]>; }',
  'node_modules/pg/index.d.ts':
    'export class Pool { query(text: string, values?: unknown[]): Promise<{ rows: object[] }>; }',
};
const header = `import { Controller, Get, Query, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Model as MongooseModel } from 'mongoose';
import { Repository, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { QueryBuilder } from 'knex';
import type { Select } from 'drizzle-orm';
import { Model as SequelizeModel } from 'sequelize';
import { Pool } from 'pg';
@Entity() class Item { @PrimaryGeneratedColumn() id!: number; }
declare const prisma: PrismaClient, pool: Pool, users: MongooseModel<{ id: number }>, items: Repository<Item>;
declare const knexQuery: QueryBuilder, drizzleQuery: Select;
declare const response: { json(value: unknown): void };
declare const limitSchema: { parse(value: unknown): { limit: number } };
`;
const request = 'req: { query: { limit?: string } }, res: typeof response';

function findings(body: string) {
  return lint(header + body, files).filter((finding: Finding) => finding.ruleId === RULE_ID);
}

test('reports a page size taken straight from the query string for each ORM', () => {
  const found =
    findings(`export async function a(${request}) { res.json(await prisma.user.findMany({ take: Number(req.query.limit) })); }
    export async function b(${request}) { res.json(await users.find().limit(Number(req.query.limit))); }
    export async function c(${request}) { res.json(await items.find({ take: Number(req.query.limit) })); }
    export async function d(${request}) { res.json(await items.createQueryBuilder().take(Number(req.query.limit))); }
    export async function e(${request}) { res.json(await knexQuery.limit(parseInt(req.query.limit!, 10))); }
    export async function f(${request}) { res.json(await drizzleQuery.limit(Number(req.query.limit))); }
    export async function g(${request}) { res.json(await SequelizeModel.findAll({ limit: Number(req.query.limit) })); }
    export async function h(${request}) { res.json(await pool.query('select id from items limit $1', [req.query.limit])); }`);
  assert.equal(found.length, 8);
  assert.ok(found.every((finding: Finding) => finding.contextualReason === undefined));
  assert.match(found[0].message, /Math\.min\(limit, 100\)/);
});

test('follows a local and a Nest query parameter to the page size', () => {
  const found = findings(`export async function a(${request}) {
      const limit = Number(req.query.limit) || 20;
      res.json(await prisma.user.findMany({ take: limit }));
    }
    @Controller('users') export class UsersController {
      @Get() list(@Query('limit') limit: string) { return prisma.user.findMany({ take: Number(limit) }); }
    }`);
  assert.equal(found.length, 2);
});

test('accepts a capped page size', () => {
  assert.deepEqual(
    findings(`export async function a(${request}) { res.json(await prisma.user.findMany({ take: Math.min(Number(req.query.limit), 100) })); }
    export async function b(${request}) {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      res.json(await users.find().limit(limit));
    }
    export async function c(${request}) {
      const limit = Number(req.query.limit);
      res.json(await items.find({ take: limit > 100 ? 100 : limit }));
    }
    export async function d(${request}) {
      let limit = Number(req.query.limit);
      if (limit > 100) limit = 100;
      res.json(await knexQuery.limit(limit));
    }
    export async function e(${request}) { res.json(await prisma.user.findMany({ take: clampLimit(req.query.limit) })); }
    declare function clampLimit(value: unknown): number;
    export async function f(${request}) { res.json(await pool.query('select id from items limit $1', [Math.min(Number(req.query.limit), 50)])); }`),
    [],
  );
});

test('accepts schema validation with a max and literal or non-request page sizes', () => {
  assert.deepEqual(
    findings(`const querySchema = { limit: z.coerce.number().max(100) };
    declare const z: { coerce: { number(): { max(value: number): number } } };
    export async function a(${request}) {
      const { limit } = limitSchema.parse(req.query);
      res.json(await prisma.user.findMany({ take: limit }));
    }
    export async function b(${request}) { res.json(await prisma.user.findMany({ take: 25 })); }
    export async function c(pageSize: number, res: typeof response) { res.json(await prisma.user.findMany({ take: pageSize })); }`),
    [],
  );
});

test('reports a service method called with a request page size as contextual', () => {
  const [finding, ...rest] = findings(`export class UsersService {
      list(limit: number) { return prisma.user.findMany({ take: limit }); }
    }
    declare const service: UsersService;
    export async function list(${request}) { res.json(await service.list(Number(req.query.limit))); }`);
  assert.equal(rest.length, 0);
  assert.ok(finding.contextualReason);
  assert.match(finding.message, /page size applied by service\.list\(\)/);
});
