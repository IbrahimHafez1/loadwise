// The table model the schema readers (Prisma, Drizzle, TypeORM, Sequelize, Mongoose, snapshots)
// build for the index rules.

/** Where a table model came from; `sql` is a raw statement or a catalog snapshot. */
export type SchemaOrm = 'prisma' | 'drizzle' | 'typeorm' | 'sequelize' | 'mongoose' | 'sql';

export interface SchemaIndexKey {
  column?: string;
  expression?: string;
  opclass?: string;
  direction?: string;
}

export interface SchemaIndex {
  name?: string;
  keys: SchemaIndexKey[];
  unique: boolean;
  primary: boolean;
  method: string;
  predicate?: string;
  file?: string;
  line?: number;
  /** The decorator or option that declares the index, since one column can carry several. */
  source?: string;
  /** Declared as a constraint (unique), not only as an index. */
  constraint?: boolean;
  /** Migration-built indexes: the table they belong to. */
  table?: string;
}

export interface ColumnForeignKey {
  table: string;
  column: string;
  position?: number;
  /** TypeORM: the relation property and whether `@JoinColumn` named the column. */
  property?: string;
  explicitName?: boolean;
}

export interface SchemaColumn {
  name: string;
  dbName: string;
  type?: string;
  file?: string;
  line?: number;
  column?: number;
  foreignKey?: ColumnForeignKey;
  array?: boolean;
  nativeType?: string;
}

export interface SchemaTable {
  name: string;
  dbName: string;
  dialect?: string;
  file?: string;
  line?: number;
  column?: number;
  columns: Map<string, SchemaColumn>;
  indexes: SchemaIndex[];
  rowEstimate?: number;
  orm?: SchemaOrm;
  /** False when some declaration could not be read, so the index list may be incomplete. */
  complete?: boolean;
  schemaName?: string;
  plugins?: boolean;
  /** Sequelize: columns the options add (timestamps) until the table is finished. */
  implicitColumns?: string[];
  underscored?: boolean;
  /** Raw SQL without a Prisma schema or snapshot behind it. */
  modelless?: boolean;
  /** The project root of a raw-SQL table. */
  root?: string;
}
