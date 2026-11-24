// Performance fix samples for TypeORM, Prisma and Drizzle builders that had no verification sample
// before.
import { drizzle } from './package-stubs.cjs';
import type { FixVerificationCase } from '../../../types/fix-verification.cjs';
import type { FileMap } from '../../../types/project-files.cjs';
import type { PerformancePolicy } from '../../../../lib/performance/types/performance-policy.cjs';

function sample(
  ruleId: string,
  source: string,
  extraFiles: FileMap = {},
  policy?: PerformancePolicy,
): FixVerificationCase {
  return { ruleId, files: { 'package.json': '{}', 'src/service.ts': source, ...extraFiles }, policy };
}

const typeormFiles = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  find(options?: object): Promise<T[]>;
  findBy(filter: object): Promise<T[]>;
  findOne(options: object): Promise<T | null>;
  findOneBy(filter: object): Promise<T | null>;
  findAndCount(options?: object): Promise<[T[], number]>;
  save(entity: T): Promise<T>;
  update(criteria: object, values: object): Promise<{ affected?: number }>;
  increment(criteria: object, column: string, value: number): Promise<{ affected?: number }>;
}
export function Column(typeOrOptions?: unknown, options?: object): PropertyDecorator;
export function PrimaryGeneratedColumn(type?: string): PropertyDecorator;
export function Entity(name?: string): ClassDecorator;`,
};

const drizzleRow = '{ id: number; teamId: number; name: string }';
const drizzleLoopFiles = {
  'node_modules/drizzle-orm/index.d.ts': `export declare function eq(column: unknown, value: unknown): unknown;
export declare function inArray(column: unknown, values: unknown[]): unknown;`,
  'node_modules/drizzle-orm/pg-core/db.d.ts': `export class Query extends Promise<${drizzleRow}[]> {
  where(predicate: unknown): Query;
}
export class Database {
  select(fields?: object): { from(table: unknown): Query };
}`,
  'src/schema.ts': 'export declare const users: { id: unknown; teamId: unknown; name: unknown };',
};

const mysqlInsertFiles = {
  'node_modules/drizzle-orm/index.d.ts': 'export function sql(parts: TemplateStringsArray): object;',
  'node_modules/drizzle-orm/mysql2/index.d.ts': `export class MySql2Database {
  insert(table: object): { values(row: object): Promise<[{ insertId: number }]> };
  execute(query: object): Promise<unknown[]>;
}`,
  'node_modules/drizzle-orm/mysql-core/index.d.ts': `export function mysqlTable(name: string, columns: object): object;
export function int(name: string): { autoincrement(): object };`,
};

const mysqlDeleteFiles = {
  'node_modules/drizzle-orm/index.d.ts':
    'export function eq(column: any, value: any): any; export function and(...terms: any[]): any;',
  'node_modules/drizzle-orm/mysql-core/index.d.ts': `export function mysqlTable<T>(name: string, columns: T, indexes: (table: T) => any[]): T;
export function int(name: string): any;
export function uniqueIndex(name: string): { on(...columns: any[]): any };`,
  'node_modules/drizzle-orm/mysql-core/db.d.ts': `export class Database {
  select(): { from(table: any): { where(condition: any): { limit(count: number): Promise<any[]> } } };
  delete(table: any): { where(condition: any): Promise<any> };
}`,
  'node_modules/drizzle-orm/mysql2/index.d.ts':
    "import { Database } from '../mysql-core/db'; export class MySql2Database extends Database {}",
};

const prismaFiles = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate {
  findMany(options?: object): Promise<{ id: number; tenantId: number }[]>;
  groupBy(options: object): Promise<object[]>;
}
export interface PostDelegate {
  groupBy(options: object): Promise<{ authorId: number; _count: { _all: number } }[]>;
}
export declare class PrismaClient { user: UserDelegate; post: PostDelegate }`,
  'prisma/schema.prisma': `model User {
  id       Int    @id
  tenantId Int
  posts    Post[]
}
model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}
`,
};

// Prisma 6.2 made `omit` generally available; the client version is what the omit fix checks.
const prismaOmitFiles = {
  'node_modules/@prisma/client/package.json': '{ "name": "@prisma/client", "version": "6.2.0" }',
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface ArticleDelegate {
  findMany(args?: { where?: object; omit?: { body?: boolean; meta?: boolean } }): Promise<{ id: number; title: string; body: string; meta: unknown }[]>;
}
export declare class PrismaClient { article: ArticleDelegate }`,
  'prisma/schema.prisma': `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Article {
  id    Int    @id
  title String
  body  String @db.Text
  meta  Json
}
`,
};

const performanceOrmCases: FixVerificationCase[] = [
  sample(
    'typeorm-wide-projection',
    `import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';
@Entity() class Row {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar' }) name!: string;
  @Column('jsonb') payload!: object;
}
declare const repo: Repository<Row>;
export async function names() {
  const rows = await repo.find({ where: { id: 'x' } });
  return rows.map((row) => ({ id: row.id, name: row.name }));
}
`,
    typeormFiles,
  ),
  sample(
    'typeorm-unused-count',
    `import { Repository } from 'typeorm';
declare const logs: Repository<{ id: number }>;
declare const where: { schoolId: number };
export async function read() {
  const [first] = await logs.findAndCount({ where });
  return first;
}
`,
    typeormFiles,
  ),
  sample(
    'typeorm-load-then-save',
    `import { Repository, Column, Entity } from 'typeorm';
@Entity()
class User {
  @Column() id!: number;
  @Column() title!: string;
}
declare const users: Repository<User>;
export async function rename(id: number) {
  const user = await users.findOneBy({ id });
  if (!user) throw new Error('missing');
  user.title = 'x';
  await users.save(user);
}
`,
    typeormFiles,
  ),
  sample(
    'drizzle-query-in-loop',
    `import { eq } from 'drizzle-orm';
import type { Database } from 'drizzle-orm/pg-core/db';
import { users } from './schema';
declare const db: Database;
export async function load(orders: { userId: number }[]) {
  for (const order of orders) {
    const [user] = await db.select().from(users).where(eq(users.id, order.userId));
    console.log(user?.name);
  }
}
`,
    drizzleLoopFiles,
  ),
  sample(
    'drizzle-last-insert-id',
    `import { sql } from 'drizzle-orm';
import { mysqlTable, int } from 'drizzle-orm/mysql-core';
import { MySql2Database } from 'drizzle-orm/mysql2';
const orders = mysqlTable('orders', { id: int('id').autoincrement() });
declare const db: MySql2Database;
export async function create() {
  await db.insert(orders).values({ name: 'a' });
  const result = await db.execute(sql\`SELECT LAST_INSERT_ID() AS id\`);
  const id = (result[0] as Array<{ id: number }>)[0]!.id;
  return id;
}
`,
    mysqlInsertFiles,
  ),
  // A real compile-and-rescan sample for the mysql2 DELETE rewrite, next to its runtime test with a
  // fake database.
  sample(
    'drizzle-write-preflight',
    `import { and, eq } from 'drizzle-orm';
import { mysqlTable, int, uniqueIndex } from 'drizzle-orm/mysql-core';
import type { MySql2Database as Database } from 'drizzle-orm/mysql2';
const links = mysqlTable('links', { owner: int('owner'), product: int('product') },
  (table) => [uniqueIndex('unique_link').on(table.owner, table.product)]);
export async function unlink(db: Database, owner: number, product: number) {
  const [found] = await db.select().from(links).where(and(eq(links.owner, owner), eq(links.product, product))).limit(1);
  if (!found) throw Error('missing link');
  await db.delete(links).where(and(eq(links.owner, owner), eq(links.product, product)));
  return 'deleted';
}
`,
    mysqlDeleteFiles,
  ),
  sample(
    'drizzle-unfiltered-write',
    `import type { Database } from 'drizzle-orm/pg-core/db';
import { invoices } from '@app/schema';
export async function archiveAll(db: Database) {
  await db.update(invoices).set({ archived: true });
}
`,
    drizzle,
  ),
  sample(
    'prisma-distinct-in-memory',
    `import type { PrismaClient } from '@prisma/client';
export async function tenants(db: PrismaClient, ids: number[]) {
  return db.user.findMany({ where: { id: { in: ids } }, select: { tenantId: true }, distinct: ['tenantId'], orderBy: { tenantId: 'asc' } });
}
`,
    prismaFiles,
  ),
  sample(
    'prisma-relation-count-in-list',
    `import type { PrismaClient } from '@prisma/client';
export async function page(db: PrismaClient) {
  const rows = await db.user.findMany({
    take: 20,
    select: { id: true, _count: { select: { posts: true } } },
  });
  return rows;
}
`,
    prismaFiles,
  ),
  sample(
    'unbounded-list-query',
    `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export async function list(req: unknown, res: { json(value: unknown): void }) {
  const rows = await prisma.user.findMany({ where: { tenantId: 1 } });
  res.json({ data: rows });
}
`,
    prismaFiles,
  ),
  sample(
    'list-query-overfetch',
    `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export async function titles() {
  const rows = await prisma.article.findMany({ where: { id: { gt: 1 } } });
  return rows.map((row) => ({ id: row.id, title: row.title }));
}
`,
    prismaOmitFiles,
  ),
];

export { performanceOrmCases };
