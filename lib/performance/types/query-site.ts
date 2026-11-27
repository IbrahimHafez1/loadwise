// A read query recognised in source, with the filters and ordering the index rules compare against
// a table model.
// Kinds: eq, in, range, null (IS NULL), other (cannot narrow by itself), pattern, expression.
import type { Node } from 'typescript';
import type { SchemaOrm, SchemaTable } from './schema-model.js';

export type ConditionKind = 'eq' | 'in' | 'range' | 'null' | 'other' | 'pattern' | 'expression';

/** A column of a table model, as a filter or ordering names it. */
export interface ColumnReference {
  table: SchemaTable;
  column: string;
}

export interface QueryCondition extends ColumnReference {
  kind: ConditionKind;
  node: Node;
  operator?: string;
  expression?: string;
  insensitive?: boolean;
}

export interface QueryOrderEntry extends ColumnReference {
  node: Node;
}

export interface QuerySite {
  orm: SchemaOrm | undefined;
  node: Node;
  /**
   * Prisma and TypeORM sites name their one table; Drizzle sites list the table and its joins in
   * `tables`.
   */
  table?: SchemaTable;
  tables?: SchemaTable[];
  conditions: QueryCondition[];
  /** Undefined when no ordering was seen, null when one was seen but could not be read. */
  order: QueryOrderEntry[] | null | undefined;
  limited: boolean;
  /** A conjunct could not be read, so it might be the covered one: rules stay silent. */
  uncertain: boolean;
  joins?: number;
}
