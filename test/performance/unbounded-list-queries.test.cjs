'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { typeorm } = require('./fixtures/schema/orm-stubs.cjs');

const RULE_ID = 'unbounded-list-query';
const typeormTypes = `${typeorm['node_modules/typeorm/index.d.ts']}
export declare class SelectQueryBuilder<T> {
  where(condition: string, parameters?: object): this; andWhere(condition: string, parameters?: object): this;
  take(count: number): this; limit(count: number): this; orderBy(sort: string): this; getMany(): Promise<T[]>;
}
export interface Repository<T> { createQueryBuilder(alias?: string): SelectQueryBuilder<T> }`;
const files = {
  'node_modules/@nestjs/common/index.d.ts': `export declare function Controller(path?: string): ClassDecorator;
    export declare function Get(path?: string): MethodDecorator;
    export declare function Post(path?: string): MethodDecorator;
    export declare function Cron(expression: string): MethodDecorator;
    export declare function Injectable(): ClassDecorator;`,
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate {
      findMany(args?: object): Promise<{ id: number }[]>;
      count(args?: object): Promise<number>;
    }
    export declare class PrismaClient { user: UserDelegate }`,
  ...typeorm,
  'node_modules/typeorm/index.d.ts': typeormTypes,
  'node_modules/pg/index.d.ts':
    'export class Pool { query(text: string, values?: unknown[]): Promise<{ rows: object[] }>; }',
};
const header = `import { Controller, Get, Post, Cron, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Repository, Entity, PrimaryGeneratedColumn, Column, In } from 'typeorm';
import { Pool } from 'pg';
declare const prisma: PrismaClient, pool: Pool, userId: number, ids: number[];
declare const response: { json(value: unknown): void; send(value: unknown): void };
@Entity() class Item { @PrimaryGeneratedColumn() id!: number; @Column() name!: string; }
declare const items: Repository<Item>;
`;

function findings(body) {
  return lint(header + body, files).filter((finding) => finding.ruleId === RULE_ID);
}

test('reports an unlimited Prisma findMany returned from a Nest route', () => {
  const [finding] = findings(`@Controller('users') export class UsersController {
    @Get() list() { return prisma.user.findMany({ where: { id: { gt: userId } } }); }
  }`);
  assert.ok(finding);
  assert.match(finding.message, /findMany\(\) has no row limit/);
});

test('follows the rows through a local into an Express-style response', () => {
  assert.equal(
    findings(`export async function list(req: unknown, res: typeof response) {
      const rows = await prisma.user.findMany();
      res.json({ data: rows });
    }`).length,
    1,
  );
});

test('reports TypeORM find, findBy and query-builder getMany and a pg SELECT in a handler', () => {
  const found = findings(`export class Items {
    @Get('a') a() { return items.find({ where: { name: 'x' } }); }
    @Get('b') b() { return items.findBy({ name: 'x' }); }
    @Get('c') c() { return items.createQueryBuilder('i').where('i.name = :n', { n: 'x' }).getMany(); }
    @Get('d') async d() { const result = await pool.query('select id from items where name = $1', ['x']); return result.rows; }
  }`);
  assert.equal(found.length, 4);
});

test('stays silent when the query has a limit', () => {
  assert.deepEqual(
    findings(`export class Items {
      @Get('a') a() { return prisma.user.findMany({ take: 50 }); }
      @Get('b') b() { return items.find({ take: 20 }); }
      @Get('c') c() { const qb = items.createQueryBuilder('i'); qb.limit(10); return qb.getMany(); }
      @Get('d') d() { return pool.query('select id from items limit 10'); }
    }`),
    [],
  );
});

test('stays silent when the filter pins a unique key or a literal list', () => {
  assert.deepEqual(
    findings(`export class Items {
      @Get('a') a() { return prisma.user.findMany({ where: { id: userId } }); }
      @Get('b') b() { return items.findBy({ id: In([1, 2, 3]) }); }
      @Get('c') c() { return prisma.user.findMany({ where: { id: { in: [1, 2] } } }); }
      @Get('d') d() { return items.createQueryBuilder('i').where('i.id = :id', { id: userId }).getMany(); }
    }`),
    [],
  );
});

test('an in-list over a variable that is not request input bounds the rows', () => {
  assert.equal(
    findings(`export class Items { @Get() a() { return prisma.user.findMany({ where: { id: { in: ids } } }); } }`)
      .length,
    0,
  );
});

test('stays silent outside request handlers and when the rows never reach the response', () => {
  assert.deepEqual(
    findings(`export class Jobs {
      @Cron('0 * * * *') async nightly() { return prisma.user.findMany(); }
      async helper() { return prisma.user.findMany(); }
    }
    export class Items {
      @Get('a') async a() { const rows = await prisma.user.findMany(); return rows.length; }
      @Get('b') async b() { const rows = await prisma.user.findMany(); return rows.slice(0, 10); }
      @Get('c') async c() { const rows = await prisma.user.findMany(); await this.audit(rows); return 'ok'; }
      @Get('d') async d() { return prisma.user.count(); }
      audit(rows: unknown) { return rows; }
    }`),
    [],
  );
});

test('stays silent when the options are not a literal', () => {
  assert.deepEqual(
    findings(`declare const options: object;
    export class Items { @Get() a() { return prisma.user.findMany(options); } @Post() b() { return prisma.user.findMany({ ...options }); } }`),
    [],
  );
});

test('Drizzle: reports select().from() without limit and stays silent with limit, count or a unique eq', () => {
  const { drizzle } = require('./fixtures/schema/orm-stubs.cjs');
  const source = `import { pgTable, uuid, text, type Database } from 'drizzle-orm/pg-core';
import { eq, count } from 'drizzle-orm';
import { Get } from '@nestjs/common';
const notes = pgTable('notes', { id: uuid().primaryKey(), title: text() });
declare const db: Database;
export class Notes {
  @Get('a') a() { return db.select().from(notes).where(eq(notes.title, 'x')); }
  @Get('b') b() { return db.select().from(notes).limit(10); }
  @Get('c') c() { return db.select({ total: count() }).from(notes); }
  @Get('d') d() { return db.select().from(notes).where(eq(notes.id, 'x')); }
}`;
  const found = lint(source, { ...files, ...drizzle }).filter((finding) => finding.ruleId === RULE_ID);
  assert.deepEqual(
    found.map((finding) => finding.line),
    [7],
  );
});

const hopHeader = `class Service {
  all() { return prisma.user.findMany(); }
  pagedBy(page: number) { return prisma.user.findMany({ where: { id: page } }); }
  limited(take?: number) { return prisma.user.findMany(); }
  fixed() { return prisma.user.findMany({ take: 10 }); }
  counted() { return prisma.user.findMany().then((rows) => rows.length); }
  inner() { return this.all(); }
}
declare const svc: Service;
`;

function hopFindings(body) {
  const lines = (header + hopHeader).split('\n').length - 1;
  return findings(hopHeader + body).map((finding) => ({ ...finding, line: finding.line - lines }));
}

test('follows one hop from a handler into the method whose result it returns', () => {
  const found = hopFindings(`export class Users {
  @Get('a') a() { return svc.all(); }
  @Get('b') async b() { return await svc.all(); }
  @Get('c') async c() { const rows = await svc.all(); response.json(rows); }
}`);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, -7, 'the finding sits on the query inside the service');
  assert.match(found[0].message, /request handler a\(\)/);
  assert.match(found[0].contextualReason, /service method a handler returns/);
});

test('one-hop findings stay quiet for paged methods, bounded queries and unreturned results', () => {
  assert.deepEqual(
    hopFindings(`export class Users {
  @Get('a') a() { return svc.pagedBy(1); }
  @Get('b') b() { return svc.limited(5); }
  @Get('c') c() { return svc.fixed(); }
  @Get('d') d() { return svc.counted(); }
  @Get('e') async e() { await svc.all(); return 'ok'; }
  @Get('f') f() { return svc.inner(); }
}`),
    [],
  );
});
