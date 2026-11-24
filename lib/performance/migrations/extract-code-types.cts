import type { Node as PgNode } from '@pgsql/types';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  LeftHandSideExpression,
  MethodDeclaration,
  Node,
  PropertyAccessExpression,
  SourceFile,
} from 'typescript';
import type { MigrationDialect, MigrationOperation, OperationInit } from '../types/migration-operations.cjs';

export type CodeFramework = 'mikro-orm' | 'typeorm' | 'sequelize' | 'knex' | 'unknown';

export type FunctionLike = FunctionExpression | ArrowFunction | MethodDeclaration | FunctionDeclaration;

/** What `up` resolves to: usually a function, but a shorthand `{ up }` may name any constant. */

export type UpTarget = FunctionLike | Expression;

export interface UpFunction {
  fn: UpTarget;
  owner: Node;
}

/** A call whose callee is a property access, such as `t.string('name')`. */

export interface ChainCall extends CallExpression {
  expression: PropertyAccessExpression;
}

export interface HelperBinding {
  node: Expression | undefined;
  bindings: Bindings;
}

/** Helper parameters bound to the arguments of the call that reached the helper. */

export type Bindings = ReadonlyMap<string, HelperBinding>;

/** A run of the built SQL text and where it comes from in the file. */

interface SqlSegment {
  sqlStart: number;
  length: number;
  fileStart: number;
  exact: boolean;
}

export interface SqlBuilder {
  sql: string;
  segments: SqlSegment[];
  dynamic: boolean;
  holes: number;
  literalText: string;
}

export interface CallParts {
  method: string;
  receiver: LeftHandSideExpression;
}

export interface BuilderDefault {
  hasDefault: boolean;
  defaultExpression: PgNode | null;
}

/** What the extractor knows about a whole migration file. */

export interface CodeContext {
  sourceFile: SourceFile;
  file: string;
  dialect: MigrationDialect;
  framework: CodeFramework;
}

/**
 * The context while reading one `up` function or helper: which parameter is the runner, what helper
 * names mean.
 */

export interface UnitContext extends CodeContext {
  firstParameter: string | undefined;
  bindings: Bindings;
}

export interface Scope {
  owner: Node | undefined;
  helpers: UpTarget[];
  explicitTransaction: boolean;
}

/**
 * What a schema-builder call contributes to an operation, before its position and SQL text are
 * added.
 */

export type BuilderFields = Omit<OperationInit, 'file' | 'line' | 'column' | 'sql' | 'builder'>;

/** An operation read from a builder call (no file yet) or from raw SQL (with its file). */

export type CodeOperation = Omit<OperationInit, 'file'> & { file?: string };

export interface AttributeFields {
  dynamicDefinition?: boolean;
  notNull?: boolean;
  serial?: boolean;
  hasDefault?: boolean;
  defaultExpression?: PgNode | null;
}

export interface ExtractedUnit {
  inTransaction: boolean;
  operations: MigrationOperation[];
}
