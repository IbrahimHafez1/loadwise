'use strict';

// Minimal package declarations for the schema-aware index tests. Paths are relative to a fixture project root.

const drizzleColumn = `export declare class Column {
  notNull(): this; primaryKey(): this; unique(name?: string): this; default(value: unknown): this; defaultNow(): this;
  references(target: () => unknown, actions?: object): this; desc(): this; asc(): this; nullsFirst(): this;
  op(name: string): this;
}
export declare class IndexBuilder {
  on(...columns: unknown[]): this; using(method: string, ...columns: unknown[]): this; where(condition: unknown): this;
  concurrently(): this;
}`;

function drizzleCore(prefix) {
  return `${drizzleColumn}
export declare function uuid(name?: string): Column;
export declare function text(name?: string, config?: object): Column;
export declare function varchar(name?: string, config?: object): Column;
export declare function integer(name?: string): Column;
export declare function int(name?: string): Column;
export declare function boolean(name?: string): Column;
export declare function timestamp(name?: string, config?: object): Column;
export declare function ${prefix}Enum(name: string, values: readonly string[]): (name?: string) => Column;
export declare function ${prefix}Table<T extends Record<string, Column>>(name: string, columns: T, extra?: (table: T) => unknown): T;
export declare function ${prefix}Schema(name: string): { table<T extends Record<string, Column>>(name: string, columns: T, extra?: (table: T) => unknown): T };
export declare function index(name?: string): IndexBuilder;
export declare function uniqueIndex(name?: string): IndexBuilder;
export declare function unique(name?: string): IndexBuilder;
export declare function primaryKey(config: { columns: Column[] }): IndexBuilder;
export declare function check(name: string, condition: unknown): IndexBuilder;
export declare class Query extends Promise<unknown[]> {
  from(table: unknown): this; where(condition: unknown): this; orderBy(...columns: unknown[]): this; limit(count: number): this;
  innerJoin(table: unknown, on: unknown): this; leftJoin(table: unknown, on: unknown): this; set(values: object): this;
}
export declare class Database { select(fields?: object): Query; update(table: unknown): Query; delete(table: unknown): Query }`;
}

const drizzle = {
  'node_modules/drizzle-orm/package.json': '{"name":"drizzle-orm","types":"index.d.ts"}',
  'node_modules/drizzle-orm/index.d.ts': `export declare class SQL { as(name: string): SQL }
export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): SQL;
export declare function eq(left: unknown, right: unknown): SQL;
export declare function ne(left: unknown, right: unknown): SQL;
export declare function gt(left: unknown, right: unknown): SQL;
export declare function gte(left: unknown, right: unknown): SQL;
export declare function lt(left: unknown, right: unknown): SQL;
export declare function lte(left: unknown, right: unknown): SQL;
export declare function inArray(left: unknown, right: unknown[]): SQL;
export declare function between(left: unknown, low: unknown, high: unknown): SQL;
export declare function like(left: unknown, pattern: string): SQL;
export declare function ilike(left: unknown, pattern: string): SQL;
export declare function isNull(left: unknown): SQL;
export declare function and(...conditions: (SQL | undefined)[]): SQL;
export declare function or(...conditions: (SQL | undefined)[]): SQL;
export declare function desc(column: unknown): SQL;
export declare function asc(column: unknown): SQL;`,
  'node_modules/drizzle-orm/pg-core/package.json': '{"types":"index.d.ts"}',
  'node_modules/drizzle-orm/pg-core/index.d.ts': drizzleCore('pg'),
  'node_modules/drizzle-orm/mysql-core/package.json': '{"types":"index.d.ts"}',
  'node_modules/drizzle-orm/mysql-core/index.d.ts': drizzleCore('mysql'),
};

function decorators(names) {
  return names.map((name) => `export declare function ${name}(...args: any[]): (...args: any[]) => any;`).join('\n');
}

const typeorm = {
  'node_modules/typeorm/package.json': '{"name":"typeorm","types":"index.d.ts"}',
  'node_modules/typeorm/index.d.ts': `${decorators([
    'Entity',
    'ViewEntity',
    'Column',
    'PrimaryColumn',
    'PrimaryGeneratedColumn',
    'CreateDateColumn',
    'UpdateDateColumn',
    'DeleteDateColumn',
    'Index',
    'Unique',
    'ManyToOne',
    'OneToOne',
    'OneToMany',
    'JoinColumn',
  ])}
export declare class FindOperator<T> { readonly value: T }
export declare function In<T>(values: T[]): FindOperator<T>;
export declare function MoreThan<T>(value: T): FindOperator<T>;
export declare function MoreThanOrEqual<T>(value: T): FindOperator<T>;
export declare function LessThan<T>(value: T): FindOperator<T>;
export declare function Between<T>(from: T, to: T): FindOperator<T>;
export declare function Like(value: string): FindOperator<string>;
export declare function ILike(value: string): FindOperator<string>;
export declare function IsNull(): FindOperator<null>;
export declare function Not<T>(value: T): FindOperator<T>;
export declare function Raw(sql: string): FindOperator<unknown>;
export interface FindManyOptions<T> { where?: object | object[]; order?: object; take?: number; skip?: number; select?: object }
export declare class Repository<T> {
  find(options?: FindManyOptions<T>): Promise<T[]>;
  findOne(options: FindManyOptions<T>): Promise<T | null>;
  findBy(where: object): Promise<T[]>;
  findOneBy(where: object): Promise<T | null>;
  findAndCount(options?: FindManyOptions<T>): Promise<[T[], number]>;
  count(options?: FindManyOptions<T>): Promise<number>;
  countBy(where: object): Promise<number>;
  query(sql: string, parameters?: unknown[]): Promise<any>;
}
export declare class EntityManager {
  find<T>(entity: new () => T, options?: FindManyOptions<T>): Promise<T[]>;
  findOne<T>(entity: new () => T, options: FindManyOptions<T>): Promise<T | null>;
  getRepository<T>(entity: new () => T): Repository<T>;
  query(sql: string, parameters?: unknown[]): Promise<any>;
}
export declare class DataSource {
  manager: EntityManager;
  getRepository<T>(entity: new () => T): Repository<T>;
  query(sql: string, parameters?: unknown[]): Promise<any>;
}
export interface QueryRunner { query(sql: string, parameters?: unknown[]): Promise<any> }
export declare class BaseEntity { static find<T>(this: new () => T, options?: FindManyOptions<T>): Promise<T[]> }`,
};

const sequelizeModel = `export interface FindOptions { where?: object; order?: unknown[]; limit?: number; offset?: number; attributes?: unknown }
export declare class Model<T = any> {
  static findAll<M>(this: new () => M, options?: FindOptions): Promise<M[]>;
  static findOne<M>(this: new () => M, options?: FindOptions): Promise<M | null>;
  static findAndCountAll<M>(this: new () => M, options?: FindOptions): Promise<{ rows: M[]; count: number }>;
  static count(options?: FindOptions): Promise<number>;
  static findByPk<M>(this: new () => M, id: unknown): Promise<M | null>;
  static init(attributes: object, options: object): void;
}`;

const sequelize = {
  'node_modules/sequelize/package.json': '{"name":"sequelize","types":"index.d.ts"}',
  'node_modules/sequelize/index.d.ts': `${sequelizeModel}
export declare const DataTypes: { BOOLEAN: unknown; UUID: unknown; STRING: unknown; DATE: unknown; INTEGER: unknown; ENUM(...values: string[]): unknown };
export declare const Op: { readonly in: unique symbol; readonly gt: unique symbol; readonly gte: unique symbol; readonly lt: unique symbol; readonly like: unique symbol; readonly iLike: unique symbol; readonly or: unique symbol; readonly ne: unique symbol };
export declare class Sequelize {
  define(name: string, attributes: object, options?: object): typeof Model;
  query(sql: string, options?: object): Promise<unknown>;
}`,
  'node_modules/sequelize-typescript/package.json': '{"name":"sequelize-typescript","types":"index.d.ts"}',
  'node_modules/sequelize-typescript/index.d.ts': `export { Model } from 'sequelize';
export declare const DataType: { BOOLEAN: unknown; UUID: unknown; STRING: unknown; DATE: unknown; INTEGER: unknown; ENUM(...values: string[]): unknown };
${decorators(['Table', 'Column', 'PrimaryKey', 'ForeignKey', 'BelongsTo', 'Default', 'AllowNull'])}
export declare function Index(...args: any[]): any;
export declare function Unique(...args: any[]): any;`,
};

module.exports = { drizzle, typeorm, sequelize };
