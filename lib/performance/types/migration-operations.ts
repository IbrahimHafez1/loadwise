// The intermediate representation every migration source (.sql, query literals, schema builders) is
// reduced to.
import type { Node as PgNode } from '@pgsql/types';
import type { ParseErrorInfo } from './pg-statements.js';

export type MigrationDialect = 'postgres' | 'mysql';

export type MigrationFramework = 'prisma' | 'drizzle' | 'typeorm' | 'knex' | 'sequelize' | 'mikro-orm' | 'sql';

export type OperationKind =
  | 'create-table'
  | 'create-index'
  | 'drop-index'
  | 'add-column'
  | 'alter-column-type'
  | 'set-not-null'
  | 'add-constraint'
  | 'validate-constraint'
  | 'drop-constraint'
  | 'rename-constraint'
  | 'drop-column'
  | 'drop-table'
  | 'rename-column'
  | 'rename-table'
  | 'alter-table-other'
  | 'drop-primary-key'
  | 'truncate'
  | 'convert-charset'
  | 'set-lock-timeout'
  | 'transaction-begin'
  | 'transaction-end'
  | 'table-rewrite-command'
  | 'unparsed'
  | 'data'
  | 'other';

export type ConstraintType = 'foreign' | 'check' | 'unique' | 'primary' | 'exclusion' | 'other';

/**
 * A column type as the parser names it: `varchar(20)[]` is name `varchar`, modifiers `[20]`, array.
 */
export interface ColumnType {
  name: string | null;
  modifiers: (number | null)[];
  array: boolean;
}

export interface CreatedColumn {
  name: string | null;
  type: ColumnType | null;
}

/** Where a migration operation sits in its file. */
export interface OperationPosition {
  file: string;
  line: number;
  column: number;
}

/** What an extractor supplies; `createOperation` fills the rest with defaults. */
export interface OperationInit extends OperationPosition {
  kind: OperationKind;
  table?: string | null;
  columnName?: string | null;
  concurrent?: boolean;
  notValid?: boolean;
  usingIndex?: boolean;
  inTransaction?: boolean;
  createdInSameUnit?: boolean;
  emptiedInSameUnit?: boolean;
  dynamic?: boolean;
  sql?: string | null;
  newName?: string | null;
  index?: string | null;
  unique?: boolean;
  constraintName?: string | null;
  constraintType?: ConstraintType | null;
  checkNotNullColumn?: string | null;
  type?: ColumnType | null;
  columns?: CreatedColumn[];
  notNull?: boolean;
  hasDefault?: boolean;
  hasUsing?: boolean;
  serial?: boolean;
  identity?: boolean;
  generatedStored?: boolean;
  defaultExpression?: PgNode | null;
  /** The migration came from a schema-builder call, not SQL text. */
  builder?: boolean;
  /** An explicit `BEGIN` or transaction wrapper in the migration itself. */
  explicitTransaction?: boolean;
  onlyParent?: boolean;
  command?: string;
  subtype?: string;
  location?: number;
  /** Offset of the statement in its raw query string; MySQL statements only. */
  statementStart?: number;
  statementKind?: string;
  algorithm?: string | null;
  lock?: string | null;
  parseError?: ParseErrorInfo;
  /** Set while a rule treats an interpolated table name as an existing table. */
  assumeTableExists?: boolean;
  renamedInSameUnit?: boolean;
  nameRecreatedInSameUnit?: boolean;
}

export interface MigrationOperation extends OperationInit {
  table: string | null;
  columnName: string | null;
  concurrent: boolean;
  notValid: boolean;
  usingIndex: boolean;
  inTransaction: boolean;
  createdInSameUnit: boolean;
  emptiedInSameUnit: boolean;
  dynamic: boolean;
  sql: string | null;
}

/** The operations of one migration file or one migration class, with the context the rules need. */
export interface MigrationUnit {
  file: string;
  framework: string;
  dialect: MigrationDialect;
  operations: MigrationOperation[];
}

export interface FindingExample {
  before: string;
  after: string;
}

export type MigrationFinding = {
  file: string;
  line: number;
  column: number;
  ruleId: string;
  message: string;
  suggestion: string;
  example: FindingExample;
  contextualReason?: string;
};

/** The text a rule builds into a finding for one operation. */
export interface FindingText {
  message: string;
  suggestion: string;
  example: FindingExample;
}
