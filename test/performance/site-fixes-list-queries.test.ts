import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { scanWithFixes, requireOnlyChange } from './site-fix-helpers.js';
import { noteOf, fixOf } from '../types/finding-fix.js';

const prismaClient = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate { findMany(args?: object): Promise<{ id: number }[]> }
export interface ArticleDelegate {
  findMany(args?: object): Promise<{ id: number; title: string; body: string; meta: unknown }[]>;
}
export declare class PrismaClient { user: UserDelegate; article: ArticleDelegate }`,
};
const packages = {
  ...prismaClient,
  'node_modules/sequelize/index.d.ts': 'export class Model { static findAll(options?: object): Promise<Model[]>; }',
  'node_modules/mongoose/index.d.ts': `export interface Query<T> extends Promise<T> { lean(): Query<T>; limit(count: number): Query<T> }
export interface Model<T> { find(filter?: object): Query<T[]> }
export declare function model<T>(name: string): Model<T>;`,
  'node_modules/typeorm/index.d.ts': `export class Repository<T> { find(options?: object): Promise<T[]>; }
export function Entity(): ClassDecorator;
export function PrimaryGeneratedColumn(): PropertyDecorator;
export function Column(): PropertyDecorator;`,
};
const response = 'type Response = { json(value: unknown): void };\n';

function unboundedFixes(context: TestContext, source: string) {
  const { findings } = scanWithFixes(context, { ...packages, 'package.json': '{}', 'src/route.ts': source });
  return findings.filter((finding) => finding.ruleId === 'unbounded-list-query');
}

test('an unbounded list gets the row-cap key of its ORM, after review', (context) => {
  const [prisma, sequelize, mongoose] = unboundedFixes(
    context,
    `import type { PrismaClient } from '@prisma/client';
import { Model } from 'sequelize';
import { model } from 'mongoose';
${response}declare const prisma: PrismaClient;
const Users = model<{ id: number }>('User');
export async function a(req: unknown, res: Response) { res.json(await prisma.user.findMany()); }
export async function b(req: unknown, res: Response) { res.json(await Model.findAll({ where: { active: true } })); }
export async function c(req: unknown, res: Response) { res.json(await Users.find({ active: true }).lean()); }
`,
  );
  assert.equal(
    requireOnlyChange(prisma).after,
    'export async function a(req: unknown, res: Response) { res.json(await prisma.user.findMany({ take: 100 })); }',
  );
  assert.match(requireOnlyChange(sequelize).after, /Model\.findAll\(\{ where: \{ active: true \}, limit: 100 \}\)/);
  assert.match(requireOnlyChange(mongoose).after, /Users\.find\(\{ active: true \}\)\.limit\(100\)\.lean\(\)/);
  for (const finding of [prisma, sequelize, mongoose]) {
    assert.equal(fixOf(finding).requiresReview, true);
    assert.match(noteOf(finding), /at most the first 100 rows/);
  }
});

test('a TypeORM find gets take, unless the file also uses Mongoose and the ORM is unclear', (context) => {
  const typeormSource = `import { Repository, Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
${response}@Entity() class Item { @PrimaryGeneratedColumn() id!: number; @Column() name!: string; }
declare const items: Repository<Item>;
export async function list(req: unknown, res: Response) { res.json(await items.find({ where: { name: 'x' } })); }
`;
  const [typeorm] = unboundedFixes(context, typeormSource);
  assert.match(requireOnlyChange(typeorm).after, /items\.find\(\{ where: \{ name: 'x' \}, take: 100 \}\)/);
  const [mixed] = unboundedFixes(context, `import 'mongoose';\n${typeormSource}`);
  assert.equal(mixed.fix, undefined);
});

test('an uncapped page size from the request is not given a row cap', (context) => {
  const [finding] = unboundedFixes(
    context,
    `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export async function list(req: { query: { take: number } }, res: { json(value: unknown): void }) {
  res.json(await prisma.user.findMany({ take: req.query.take }));
}
`,
  );
  assert.match(finding.message, /page size/);
  assert.equal(finding.fix, undefined);
});

const articleSchema = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Article {
  id    Int    @id
  title String
  body  String @db.Text
  meta  Json
}
`;

function overfetchFixes(context: TestContext, source: string, clientVersion: string) {
  const { findings } = scanWithFixes(context, {
    ...prismaClient,
    'node_modules/@prisma/client/package.json': JSON.stringify({ name: '@prisma/client', version: clientVersion }),
    'package.json': '{}',
    'prisma/schema.prisma': articleSchema,
    'src/articles.ts': `import type { PrismaClient } from '@prisma/client';\ndeclare const prisma: PrismaClient;\n${source}`,
  });
  return findings.filter((finding) => finding.ruleId === 'list-query-overfetch');
}

const titlesOnly = `export async function titles() {
  const rows = await prisma.article.findMany({ where: { id: { gt: 1 } } });
  return rows.map((row) => ({ id: row.id, title: row.title, body: row.body }));
}`;

test('large Prisma columns the function never reads are omitted on Prisma 6.2 and later', (context) => {
  const [finding] = overfetchFixes(context, titlesOnly, '6.2.1');
  assert.equal(
    requireOnlyChange(finding).after,
    'const rows = await prisma.article.findMany({ where: { id: { gt: 1 } }, omit: { meta: true } });',
  );
  assert.match(noteOf(finding), /`meta`/);
});

test('no omit fix for an older Prisma client or rows that leave the function whole', (context) => {
  const [older] = overfetchFixes(context, titlesOnly, '6.1.0');
  assert.equal(older.fix, undefined);
  const [returned] = overfetchFixes(
    context,
    'export const list = () => prisma.article.findMany({ where: { id: { gt: 1 } } });',
    '6.2.0',
  );
  assert.ok(returned.contextualReason);
  assert.equal(returned.fix, undefined);
});
