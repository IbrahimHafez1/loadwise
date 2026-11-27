// The indexes a project's migration files create, read from their text.
import type { SchemaIndex } from './schema-model.js';

/** One index key as written: a plain column, or an expression with the columns it mentions. */
export interface ParsedKey {
  column?: string;
  /** The column as the database stores it, which messages show. */
  spelling?: string;
  opclass?: string;
  ordering?: string;
  expression?: string;
  columns?: string[];
}

/** An index a migration creates. */
export interface IndexCreation {
  table: string;
  /** Lower-case name, which a later drop matches. */
  name?: string;
  spelling?: string;
  keys: ParsedKey[];
  unique: boolean;
  method?: string;
  partial?: boolean;
  /** Created by a constraint, so only DROP CONSTRAINT removes it. */
  constraint?: boolean;
  primary?: boolean;
  plainKeys?: boolean;
}

/** An index still live after replaying the migrations, with where it was created. */
export interface LiveIndex extends IndexCreation {
  file: string;
  /** Character offset of the creating statement in its file. */
  at: number;
  directory: string | undefined;
}

/**
 * A partial or non-btree index: it silences rules through its keys but does not count as coverage.
 */
export interface OtherIndex {
  keys: { column?: string; columns?: string[] }[];
  method: string;
  partial?: boolean;
}

/** What the migrations say about one table's indexes. */
export interface MigrationTableEntry {
  /** The index set is not fully read, so rules stay silent on this table. */
  opaque: boolean;
  indexes: SchemaIndex[];
  others: OtherIndex[];
  mentioned: Set<string>;
  expressionColumns: Set<string>;
  patternColumns: Set<string>;
}

export interface MigrationDeclarations {
  indexes: LiveIndex[];
  opaqueTables: Set<string>;
}
