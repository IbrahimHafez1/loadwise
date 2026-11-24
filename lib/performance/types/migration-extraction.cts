// What the migration extractors (SQL text, query literals in code) hand to one another and to the
// rules.
import type { MigrationDialect, MigrationOperation } from './migration-operations.cjs';
import type { SourcePosition } from './source-position.cjs';

/** Turns a character offset in the extracted SQL text into a position in the file. */
export type OffsetMapper = (offset: number) => SourcePosition;

export interface SqlExtraction {
  operations: MigrationOperation[];
  statementCount: number;
}

export interface SqlExtractionOptions {
  dialect: MigrationDialect;
  file: string;
  /** Defaults to a 1:1 mapping, which is right for .sql files but not for query literals. */
  mapOffset?: OffsetMapper;
}
