'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { typeorm } = require('./fixtures/schema/orm-stubs.cjs');

const RULE_ID = 'list-query-overfetch';
const prismaProject = '../fixtures/overfetch/prisma-app/';
const prismaDelegates = ['Article', 'Tag', 'Comment']
  .map((model) => `export interface ${model}Delegate { findMany(args?: object): Promise<any[]>; }`)
  .join('\n');
const prismaStub = `${prismaDelegates}
export declare class PrismaClient { article: ArticleDelegate; tag: TagDelegate; comment: CommentDelegate }`;
const prismaFiles = { [`${prismaProject}node_modules/.prisma/client/index.d.ts`]: prismaStub };
const prismaImport = `import { PrismaClient } from '${prismaProject}node_modules/.prisma/client';\ndeclare const prisma: PrismaClient;\n`;
const typeormImport = `import { Repository, Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
@Entity() class Post {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ type: 'jsonb' }) payload!: object;
  @Column('text') body!: string;
}
@Entity() class Label { @PrimaryGeneratedColumn() id!: number; @Column() name!: string; }
declare const posts: Repository<Post>, labels: Repository<Label>;
`;

function findings(source, extraFiles) {
  return lint(source, extraFiles).filter((finding) => finding.ruleId === RULE_ID);
}

const prismaFindings = (body) => findings(prismaImport + body, prismaFiles);
const typeormFindings = (body) => findings(typeormImport + body, typeorm);

test('Prisma: reports Json and @db.Text columns loaded by a list without select', () => {
  const [finding] = prismaFindings('export const list = () => prisma.article.findMany({ where: { id: { gt: 1 } } });');
  assert.ok(finding);
  assert.match(finding.message, /body \(Text\), meta \(Json\)/);
  assert.match(finding.contextualReason, /returned or passed on whole/);
});

test('Prisma: large columns the code never reads are reported plainly, and read ones are not', () => {
  const found = prismaFindings(`export async function titles() {
  const rows = await prisma.article.findMany({ where: { id: { gt: 1 } } });
  return rows.map((row) => ({ id: row.id, title: row.title, body: row.body }));
}
export async function counted() {
  const rows = await prisma.article.findMany({ where: { id: { gt: 1 } } });
  for (const { id, meta } of rows) console.log(id, meta);
  return rows.length;
}
export async function everything() {
  const rows = await prisma.article.findMany({ where: { id: { gt: 1 } } });
  const copy = [...rows];
  return copy;
}`);
  assert.equal(found.length, 3);
  assert.ok(found[0].message.includes('(meta (Json))'));
  assert.equal(found[0].contextualReason, undefined);
  assert.ok(found[1].message.includes('(body (Text))'));
  assert.equal(found[1].contextualReason, undefined);
  assert.match(found[2].contextualReason, /returned or passed on whole/);
});

test('Prisma: reports include nesting two levels deep', () => {
  const [finding] = prismaFindings(
    'export const list = () => prisma.comment.findMany({ include: { article: true, replies: { include: { comment: true } } } });',
  );
  assert.ok(finding);
  assert.match(finding.message, /includes 2 relation levels deep/);
  assert.doesNotMatch(finding.message, /large columns/);
});

test('Prisma: stays silent with select or omit, narrow models, small pages and single includes', () => {
  assert.deepEqual(
    prismaFindings(`export const a = () => prisma.article.findMany({ select: { id: true, title: true } });
export const b = () => prisma.article.findMany({ omit: { body: true, meta: true } });
export const c = () => prisma.tag.findMany();
export const d = () => prisma.article.findMany({ take: 20 });
export const e = () => prisma.comment.findMany({ include: { article: true } });
declare const options: object;
export const f = () => prisma.article.findMany(options);`),
    [],
  );
});

test('Prisma: without a schema only nested include is reported, and it is contextual', () => {
  const source = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export const wide = () => prisma.article.findMany();
export const deep = () => prisma.article.findMany({ include: { comments: { include: { replies: true } } } });`;
  const found = findings(source, {
    'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
    'node_modules/.prisma/client/index.d.ts': `export interface ArticleDelegate { findMany(args?: object): Promise<any[]>; }
export declare class PrismaClient { article: ArticleDelegate }`,
  });
  assert.equal(found.length, 1);
  assert.match(found[0].contextualReason, /No schema was found/);
});

test('TypeORM: reports text and jsonb columns and relation chains in find', () => {
  const found = typeormFindings(`export const wide = () => posts.find({ where: { title: 'x' } });
export const deep = () => labels.find({ relations: ['posts.author'] });`);
  assert.equal(found.length, 2);
  assert.match(found[0].message, /payload \(jsonb\), body \(text\)/);
  assert.match(found[1].message, /loads 2 relation levels deep/);
});

test('TypeORM: stays silent with select, a small page, or narrow entities', () => {
  assert.deepEqual(
    typeormFindings(`export const a = () => posts.find({ select: { id: true, title: true } });
export const b = () => posts.find({ take: 10 });
export const c = () => labels.find({ where: { name: 'x' } });`),
    [],
  );
});
