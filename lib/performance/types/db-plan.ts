// EXPLAIN (FORMAT JSON) documents as `db` reads them.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** One PostgreSQL plan node; only the fields `db` reads. */
export interface PlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  Schema?: string;
  Filter?: string;
  'Index Name'?: string;
  'Plan Rows'?: number;
  'Total Cost'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

/** The document root: PostgreSQL has `Plan` (plus timing with ANALYZE), MySQL has `query_block`. */
export interface PlanRoot {
  Plan?: PlanNode;
  'Execution Time'?: number;
  query_block?: JsonValue;
}

/** `undefined` when EXPLAIN returned no rows. */
export type PlanDocument = PlanRoot | PlanRoot[] | undefined;

type PlanPayload = string | PlanRoot | PlanRoot[];

/** The single row EXPLAIN returns; the column is named differently by PostgreSQL and MySQL. */
export interface PlanRow {
  'QUERY PLAN'?: PlanPayload;
  EXPLAIN?: PlanPayload;
}

/** A MySQL table access entry found anywhere inside `query_block`. */
export interface MysqlTableAccess {
  access_type: string;
  table_name: string;
  attached_condition?: JsonValue;
  rows_examined_per_scan?: JsonValue;
}
