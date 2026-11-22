'use strict';

// Corpus false positives (k12, simbel, strapi, directus, admissions, immich, outline): fixed SQL text, field-level
// object taint, fixed URL origins and relative redirects stay quiet; the nearest unsafe shapes are still reported.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintBothWays, stubs } = require('./helpers.cjs');

const sqlRules = new Set(['typeorm-dynamic-query-text', 'knex-raw-dynamic-text', 'sequelize-dynamic-query-text']);

const packages = {
  ...stubs.express,
  'node_modules/typeorm/index.d.ts': [
    'export declare class DataSource { query(text: string, parameters?: unknown[]): Promise<unknown>;',
    '  createQueryBuilder(alias: string): SelectQueryBuilder }',
    'export declare class SelectQueryBuilder { where(text: string, parameters?: object): SelectQueryBuilder;',
    '  andWhere(text: string, parameters?: object): SelectQueryBuilder;',
    '  addSelect(text: string): SelectQueryBuilder }',
    'export interface QueryRunner { query(text: string, parameters?: unknown[]): Promise<unknown> }',
    'export interface MigrationInterface { up(queryRunner: QueryRunner): Promise<void> }',
  ].join('\n'),
  'node_modules/knex/index.d.ts': [
    'export interface Knex { raw(text: string, bindings?: unknown[]): unknown; (table: string): QueryBuilder }',
    'export interface QueryBuilder { whereRaw(text: string, bindings?: unknown[]): QueryBuilder }',
    'export declare function knex(config: object): Knex; export default knex;',
  ].join('\n'),
  'node_modules/sequelize/index.d.ts': [
    'export declare class Sequelize { constructor(url: string); query(text: string, options?: object): Promise<unknown>;',
    '  escape(value: unknown): string; static literal(text: string): unknown }',
  ].join('\n'),
};

function route(body, preamble = '') {
  return [
    "import express from 'express';",
    preamble,
    'const app = express();',
    `app.get('/x', async (req, res) => {`,
    body,
    '});',
  ].join('\n');
}

function ruleFindings(source, rules) {
  return lintBothWays(source, packages)
    .typed.filter((finding) => rules.has(finding.ruleId))
    .map((finding) => [finding.ruleId, finding.line, finding.contextualReason ? 'C' : 'D']);
}

const sqlFindings = (source) => ruleFindings(source, sqlRules);

test('createQueryBuilder counts as TypeORM only when it resolves to typeorm or the file imports it', () => {
  const strapi = route(
    'db.entityManager.createQueryBuilder(uid).addSelect(`${alias}.${req.query.column}`);',
    'declare const db: any, uid: string, alias: string;',
  );
  assert.deepEqual(sqlFindings(strapi), []);
  const typed = route(
    "dataSource.createQueryBuilder('u').where(`u.name = ${req.query.name}`);",
    "import { DataSource } from 'typeorm';\ndeclare const dataSource: DataSource;",
  );
  assert.deepEqual(sqlFindings(typed), [['typeorm-dynamic-query-text', 6, 'D']]);
  const imported = route(
    "manager.createQueryBuilder('u').where(`u.name = ${req.query.name}`);",
    "import { DataSource } from 'typeorm';\ndeclare const manager: any;",
  );
  assert.deepEqual(sqlFindings(imported), [['typeorm-dynamic-query-text', 6, 'D']]);
});

test('a let built only from literal appends is fixed SQL text; a runtime append is not', () => {
  const build = (append) =>
    route(
      [
        "let scope = 'SELECT i.id FROM invoices i WHERE (i.student_id IN (:...ids)';",
        "if (req.query.family) scope += ' OR i.family_id IN (:...familyIds)';",
        `scope += ${append};`,
        "dataSource.createQueryBuilder('p').andWhere(`p.invoice_id IN (${scope})`, {});",
      ].join('\n'),
      "import { DataSource } from 'typeorm';\ndeclare const dataSource: DataSource;\ndeclare const suffix: string;",
    );
  assert.deepEqual(sqlFindings(build("')'")), []);
  assert.deepEqual(sqlFindings(build('suffix')), [['typeorm-dynamic-query-text', 10, 'C']]);
  assert.deepEqual(sqlFindings(build('req.query.extra')), [['typeorm-dynamic-query-text', 10, 'D']]);
});

test('a for-of variable over a literal array is fixed SQL text in migrations', () => {
  const migration = (loops) =>
    [
      "import { MigrationInterface, QueryRunner } from 'typeorm';",
      "const tables = ['schools', 'school_profiles'] as const;",
      "const policies = [['schools', 'p_read'], ['profiles', 'p_write']];",
      'export class Migration implements MigrationInterface {',
      "  private readonly columns = ['a', 'b'];",
      '  async up(queryRunner: QueryRunner, names: string[]): Promise<void> {',
      loops,
      '  }',
      '}',
    ].join('\n');
  const fixed = migration(
    [
      'for (const t of tables) await queryRunner.query(`DROP TABLE IF EXISTS "${t}"`);',
      "for (const table of ['a', 'b']) await queryRunner.query(`ALTER TABLE \"${table}\" ADD x int`);",
      'for (const [table, policy] of policies) await queryRunner.query(`DROP POLICY "${policy}" ON "${table}"`);',
      'for (const column of this.columns) await queryRunner.query(`ALTER TABLE t DROP "${column}"`);',
    ].join('\n'),
  );
  assert.deepEqual(sqlFindings(fixed), []);
  const open = migration('for (const name of names) await queryRunner.query(`DROP TABLE "${name}"`);');
  assert.deepEqual(sqlFindings(open), [['typeorm-dynamic-query-text', 7, 'C']]);
});

test('a placeholder list mapped from values is fixed text; mapping the values themselves is not', () => {
  const preamble = "import knex from 'knex';\nconst db = knex({});";
  const fixed = route(
    [
      "const placeholders = req.query.ids.map(() => '?').join(', ');",
      'db("users").whereRaw(`?? in (${placeholders})`, [req.query.column, ...req.query.ids]);',
      "db('users').whereRaw(`email in (${req.body.emails.map(() => '?')})`, req.body.emails);",
      "db.raw(`SELECT * FROM t WHERE id IN (${req.body.ids.map((_, i) => '$' + (i + 1)).join(',')})`);",
    ].join('\n'),
    preamble,
  );
  assert.deepEqual(sqlFindings(fixed), []);
  const tainted = route(
    [
      "db('users').whereRaw(`id in (${req.body.ids.map((id) => id).join(',')})`);",
      "db('users').whereRaw(`id in (${req.body.ids.map(() => '?').join(req.query.separator)})`);",
    ].join('\n'),
    preamble,
  );
  assert.deepEqual(sqlFindings(tainted), [
    ['knex-raw-dynamic-text', 6, 'D'],
    ['knex-raw-dynamic-text', 7, 'C'],
  ]);
});

test('sequelize.escape output is fixed text; private fields assigned only fixed text are fixed', () => {
  const preamble = [
    "import { Sequelize } from 'sequelize';",
    "const sequelize = new Sequelize('db');",
    "const PREFIX = 'popularity';",
    'class Task {',
    "  private workingTable = '';",
    '  run(day: string) {',
    '    this.workingTable = `${PREFIX}_scores`;',
    '    sequelize.query(`DROP TABLE ${this.workingTable}`);',
    '  }',
    '  other(day: string) {',
    '    this.workingTable = `${PREFIX}_${day}`;',
    '  }',
    '}',
  ].join('\n');
  const source = route(
    [
      'Sequelize.literal(`(SELECT id FROM users WHERE "teamId" = ${sequelize.escape(req.query.team)})`);',
      'Sequelize.literal(`(SELECT id FROM users WHERE "teamId" = ${req.query.team})`);',
    ].join('\n'),
    preamble,
  );
  assert.deepEqual(sqlFindings(source), [
    ['sequelize-dynamic-query-text', 9, 'C'],
    ['sequelize-dynamic-query-text', 18, 'D'],
  ]);
  const onlyFixed = preamble.replace('`${PREFIX}_${day}`', "'scores_tmp'");
  assert.deepEqual(sqlFindings(route('', onlyFixed)), []);
});

test('taint through an object literal stays with the field it came from', () => {
  const source = route(
    ["store({ filename: req.body.name, sourcePath: '/tmp/upload' });", 'storeAll({ ...req.body });'].join('\n'),
    [
      "import { readFile } from 'fs/promises';",
      'async function store(opts: { filename: string; sourcePath: string }) {',
      '  await readFile(opts.sourcePath);',
      '  const { sourcePath } = opts;',
      '  await readFile(sourcePath);',
      '  await readFile(opts.filename);',
      '}',
      'async function storeAll(opts: { sourcePath: string }) {',
      '  await readFile(opts.sourcePath);',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(ruleFindings(source, new Set(['path-traversal'])), [
    ['path-traversal', 7, 'D'],
    ['path-traversal', 10, 'D'],
  ]);
});

