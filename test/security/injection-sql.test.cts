// The six SQL-text rules: request data reaching SQL text is default, assembled text with no traced
// part is contextual, and constant fragments, bound values, number-like values and allowlisted
// identifiers are silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintBothWays, lintWithoutTypes, stubs } from './helpers.cjs';
import type { LocatedFinding } from '../types/security.cjs';

const sqlRules = new Set([
  'prisma-raw-unsafe-dynamic',
  'typeorm-dynamic-query-text',
  'knex-raw-dynamic-text',
  'mysql-dynamic-query-text',
  'sequelize-dynamic-query-text',
  'drizzle-sql-raw-dynamic',
]);

const packages = {
  ...stubs.express,
  ...stubs.nest,
  ...stubs.typeorm,
  'node_modules/knex/index.d.ts': [
    'export interface Knex { raw(text: string, bindings?: unknown[]): unknown; (table: string): QueryBuilder }',
    'export interface QueryBuilder { whereRaw(text: string, bindings?: unknown[]): QueryBuilder }',
    'export declare function knex(config: object): Knex; export default knex;',
  ].join('\n'),
  'node_modules/mysql2/index.d.ts': [
    'export interface Pool { query(text: string, values?: unknown[]): Promise<unknown>;',
    '  execute(text: string, values?: unknown[]): Promise<unknown> }',
    'export declare function createPool(config: object): Pool;',
  ].join('\n'),
  'node_modules/sequelize/index.d.ts': [
    'export declare class Sequelize { constructor(url: string); query(text: string, options?: object): Promise<unknown>;',
    '  static literal(text: string): unknown }',
    'export declare function literal(text: string): unknown;',
  ].join('\n'),
  'node_modules/drizzle-orm/index.d.ts':
    'export declare const sql: { raw(text: string): unknown; identifier(name: string): unknown };',
};

function sqlFindings(source: string, files = packages) {
  const { typed } = lintBothWays(source, files);
  return typed
    .filter((finding: LocatedFinding) => sqlRules.has(finding.ruleId))
    .map((finding: LocatedFinding) => [finding.ruleId, finding.line, finding.contextualReason ? 'C' : 'D']);
}

function route(body: string, preamble = '') {
  return [
    "import express from 'express';",
    preamble,
    'const app = express();',
    `app.get('/x', (req, res) => {`,
    body,
    '});',
  ].join('\n');
}

test('prisma raw unsafe calls with request data in the text are default', () => {
  const source = route(
    [
      'prisma.$queryRawUnsafe(`SELECT * FROM users ORDER BY ${req.query.sort}`);',
      'const sort = req.query.sort;',
      "prisma.$executeRawUnsafe('DELETE FROM t WHERE c = ' + sort);",
      'prisma.$queryRaw(Prisma.raw(`SELECT ${sort}`));',
      'prisma.$queryRawUnsafe(req.body.sql);',
    ].join('\n'),
    'declare const prisma: any, Prisma: any;',
  );
  assert.deepEqual(sqlFindings(source), [
    ['prisma-raw-unsafe-dynamic', 5, 'D'],
    ['prisma-raw-unsafe-dynamic', 7, 'D'],
    ['prisma-raw-unsafe-dynamic', 8, 'D'],
    ['prisma-raw-unsafe-dynamic', 9, 'D'],
  ]);
  const [finding] = lintWithoutTypes(source, packages);
  assert.match(finding.message, /runtime value \(`req\.query\.sort`\), which allows SQL injection/);
  assert.ok(finding.trace && finding.trace.length >= 2);
});

test('prisma raw text with placeholders, constants, numbers and allowlisted identifiers is silent', () => {
  const source = [
    'declare const prisma: any;',
    "const TABLE = 'users';",
    "const COLUMNS = ['name', 'createdAt'];",
    'async function list(limit: number, column: string, id: string) {',
    "  await prisma.$queryRawUnsafe('SELECT * FROM users WHERE id = $1', id);",
    '  await prisma.$queryRawUnsafe(`SELECT * FROM ${TABLE} LIMIT ${limit}`);',
    "  if (!COLUMNS.includes(column)) throw new Error('bad column');",
    '  await prisma.$queryRawUnsafe(`SELECT * FROM users ORDER BY ${column}`);',
    "  let text = 'SELECT * FROM users';",
    "  if (limit) text += ' LIMIT ' + limit;",
    '  await prisma.$queryRawUnsafe(text);',
    '}',
  ].join('\n');
  assert.deepEqual(sqlFindings(source), []);
});

test('assembled raw text with no traced part is contextual; a plain wrapper parameter is silent', () => {
  const source = [
    'declare const prisma: any;',
    'export async function bySchema(schema: string, text: string) {',
    '  await prisma.$queryRawUnsafe(`SELECT * FROM ${schema}.users`);',
    '  await prisma.$queryRawUnsafe(text);',
    '}',
  ].join('\n');
  assert.deepEqual(sqlFindings(source), [['prisma-raw-unsafe-dynamic', 3, 'C']]);
  assert.match(lintWithoutTypes(source)[0].contextualReason ?? '', /No request value was traced/);
});

test('request data through a let accumulator and a service hop is default', () => {
  const source = [
    "import { Controller, Get, Query } from '@nestjs/common';",
    "import { DataSource } from 'typeorm';",
    'class Reports {',
    '  constructor(private readonly dataSource: DataSource) {}',
    '  run(sort: string) {',
    "    let text = 'SELECT * FROM report';",
    '    text += ` ORDER BY ${sort}`;',
    '    return this.dataSource.query(text);',
    '  }',
    '}',
    '@Controller() class ReportsController {',
    '  constructor(private readonly reports: Reports) {}',
    "  @Get() list(@Query('sort') sort: string) { return this.reports.run(sort); }",
    '}',
  ].join('\n');
  assert.deepEqual(sqlFindings(source), [['typeorm-dynamic-query-text', 8, 'D']]);
});

test('typeorm query builder conditions with interpolation are reported; parameters and aliases are not', () => {
  const source = route(
    [
      "const qb = dataSource.createQueryBuilder('user');",
      'qb.where(`user.name = ${req.query.name}`);',
      "dataSource.createQueryBuilder('user').where('user.name = :name', { name: req.query.name });",
      'dataSource.createQueryBuilder(ALIAS).andWhere(`${ALIAS}.id = :id`, { id: req.query.id });',
      'dataSource.createQueryBuilder(ALIAS).orderBy(req.query.sort as string);',
      "dataSource.createQueryBuilder(ALIAS).leftJoin('user.photos', 'photo', `photo.kind = '${req.query.kind}'`);",
      'dataSource.createQueryBuilder(ALIAS).select([`${ALIAS}.id`, `${ALIAS}.${req.query.field}`]);',
    ].join('\n'),
    "import { DataSource } from 'typeorm';\ndeclare const dataSource: DataSource;\nconst ALIAS = 'user';",
  );
  assert.deepEqual(sqlFindings(source), [
    ['typeorm-dynamic-query-text', 8, 'D'],
    ['typeorm-dynamic-query-text', 11, 'D'],
    ['typeorm-dynamic-query-text', 12, 'D'],
    ['typeorm-dynamic-query-text', 13, 'D'],
  ]);
});

test('typeorm where on a non-builder receiver is not a typeorm sink', () => {
  const source = route('repository.where(`a = ${req.query.a}`);', 'declare const repository: any;');
  assert.deepEqual(sqlFindings(source), []);
});

test('knex raw fragments and knex.raw with request text are reported; bindings are not', () => {
  const source = route(
    [
      "db('users').whereRaw(`name = '${req.query.name}'`);",
      "db('users').whereRaw('name = ?', [req.query.name]);",
      'db.raw(`SELECT ${req.query.column} FROM users`);',
      "db.raw('SELECT ?? FROM users', [req.query.column]);",
      'other.raw(`SELECT ${req.query.column}`);',
    ].join('\n'),
    "import knex from 'knex';\nconst db = knex({});\ndeclare const other: { raw(text: string): void };",
  );
  assert.deepEqual(sqlFindings(source), [
    ['knex-raw-dynamic-text', 7, 'D'],
    ['knex-raw-dynamic-text', 9, 'D'],
  ]);
});

test('mysql pool queries with request text are reported; placeholders are not', () => {
  const source = route(
    [
      "pool.query('SELECT * FROM t WHERE id = ' + req.params.id);",
      "pool.execute('SELECT * FROM t WHERE id = ?', [req.params.id]);",
      'pool.execute(`SELECT * FROM t ORDER BY ${req.query.sort}`);',
    ].join('\n'),
    "import mysql from 'mysql2';\nconst pool = mysql.createPool({});",
  );
  assert.deepEqual(sqlFindings(source), [
    ['mysql-dynamic-query-text', 6, 'D'],
    ['mysql-dynamic-query-text', 8, 'D'],
  ]);
});

test('sequelize query and literal with request text are reported; replacements are not', () => {
  const source = route(
    [
      'sequelize.query(`SELECT * FROM t WHERE name = ${req.body.name}`);',
      "sequelize.query('SELECT * FROM t WHERE name = :name', { replacements: { name: req.body.name } });",
      'literal(`(SELECT COUNT(*) FROM t WHERE c = ${req.query.c})`);',
      "Sequelize.literal('id = ' + req.query.id);",
    ].join('\n'),
    "import { Sequelize, literal } from 'sequelize';\nconst sequelize = new Sequelize('db');",
  );
  assert.deepEqual(sqlFindings(source), [
    ['sequelize-dynamic-query-text', 6, 'D'],
    ['sequelize-dynamic-query-text', 8, 'D'],
    ['sequelize-dynamic-query-text', 9, 'D'],
  ]);
});

test('drizzle sql.raw with request text is reported; sql.raw of a constant and other raw helpers are not', () => {
  const source = route(
    [
      'sql.raw(`ORDER BY ${req.query.sort}`);',
      "sql.raw('ORDER BY created_at');",
      'local.raw(`ORDER BY ${req.query.sort}`);',
    ].join('\n'),
    "import { sql } from 'drizzle-orm';\ndeclare const local: { raw(text: string): void };",
  );
  assert.deepEqual(sqlFindings(source), [['drizzle-sql-raw-dynamic', 6, 'D']]);
});

test('a parsing pipe and a number type keep request values out of the SQL rules', () => {
  const source = [
    "import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';",
    'declare const prisma: any;',
    '@Controller() class Items {',
    "  @Get() one(@Param('id', ParseIntPipe) id: number) { return prisma.$queryRawUnsafe(`SELECT ${id}`); }",
    "  @Get() page(@Query('page') page: string) { return prisma.$queryRawUnsafe(`SELECT ${Number(page)}`); }",
    '}',
  ].join('\n');
  assert.deepEqual(sqlFindings(source), []);
});
