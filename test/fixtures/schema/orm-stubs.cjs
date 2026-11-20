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

module.exports = { drizzle };
