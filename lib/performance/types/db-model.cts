// Shapes shared by the `db` modules: the schema model built from catalog rows, the rows themselves
// and `db` findings.

/** Counters come back from the drivers as numbers, numeric strings (bigint) or null. */
export type CatalogNumber = number | string | null | undefined;

export interface DbImpact {
  kind: 'estimated' | 'measured';
  before: number;
  after: number;
  unit: string;
  method: string;
}

/** A finding of `db`: about a table (`target`) or, for `--queries`, about a statement in a file. */
export type DbFinding = {
  target?: string;
  file?: string;
  line?: number;
  column?: number;
  ruleId: string;
  message: string;
  suggestion?: string;
  contextualReason?: string;
  impact?: DbImpact;
  measurement?: string;
};

export interface IndexKey {
  column?: string;
  expression?: string;
  opclass?: string;
  direction?: 'asc' | 'desc';
  semantics?: string;
}

export interface IndexModel {
  name: string;
  keys: IndexKey[];
  unique: boolean;
  primary: boolean;
  method: string;
  predicate?: string;
  backsConstraint?: boolean;
  protected?: boolean;
  usable?: boolean;
  duplicateComparable?: boolean;
  scans?: number;
  sizeBytes?: number;
}

export interface ForeignKeyModel {
  name: string;
  columns: string[];
  references: { table: string; columns: string[] };
}

export interface TableModel {
  schema: string;
  name: string;
  rowEstimate?: number;
  sizeBytes?: number;
  seqScan?: number;
  seqTupRead?: number;
  idxScan?: number;
  liveTuples?: number;
  columns: string[];
  indexes: IndexModel[];
  foreignKeys: ForeignKeyModel[];
}

/** Tables by `schema.table`. */
export type SchemaModel = Map<string, TableModel>;

export interface PgTableRow {
  schema_name: string;
  table_name: string;
  row_estimate?: CatalogNumber;
  size_bytes?: CatalogNumber;
  seq_scan?: CatalogNumber;
  seq_tup_read?: CatalogNumber;
  idx_scan?: CatalogNumber;
  n_live_tup?: CatalogNumber;
}

export interface PgColumnRow {
  schema_name: string;
  table_name: string;
  column_name: string;
}

export interface PgIndexRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  method: string;
  is_unique?: boolean;
  is_primary?: boolean;
  is_usable?: boolean;
  is_protected?: boolean;
  duplicate_comparable?: boolean;
  backs_constraint?: boolean;
  predicate?: string | null;
  key_columns: (string | null)[];
  key_definitions: string[];
  key_opclasses?: string[];
  key_descending?: boolean[];
  key_semantics?: string[];
  idx_scan?: CatalogNumber;
  size_bytes?: CatalogNumber;
}

export interface PgForeignKeyRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  columns: string[];
  referenced_schema: string;
  referenced_table: string;
  referenced_columns: string[];
}

export interface PostgresCatalogRows {
  tables?: PgTableRow[];
  columns?: PgColumnRow[];
  indexes?: PgIndexRow[];
  foreignKeys?: PgForeignKeyRow[];
}

export interface MysqlTableRow {
  schema_name: string;
  table_name: string;
  row_estimate?: CatalogNumber;
  size_bytes?: CatalogNumber;
}

export interface MysqlIndexRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  non_unique: CatalogNumber;
  column_name?: string | null;
  expression?: string | null;
  index_type: string;
  collation?: string | null;
}

export interface MysqlForeignKeyRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
}

export interface MysqlCatalogRows {
  tables?: MysqlTableRow[];
  indexes?: MysqlIndexRow[];
  foreignKeys?: MysqlForeignKeyRow[];
}

export interface MysqlUnusedIndexRow {
  schema_name: string;
  table_name: string;
  index_name: string;
}

export interface MysqlRedundantIndexRow {
  schema_name: string;
  table_name: string;
  redundant_index_name: string;
  redundant_index_columns: string;
  dominant_index_name: string;
  dominant_index_columns: string;
}

/** A row of `pg_extension`. */
export interface ExtensionRow {
  name: string;
}

export interface MysqlFindingInputs {
  unusedIndexes?: MysqlUnusedIndexRow[];
  redundantIndexes?: MysqlRedundantIndexRow[];
  uptimeDays?: number;
}
