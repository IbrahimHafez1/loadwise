// Statements the Postgres parser produces.
import type { Node as PgNode } from '@pgsql/types';
import type { SourcePosition } from './source-position.cjs';

type UnionToIntersection<Union> = (Union extends unknown ? (member: Union) => void : never) extends (
  member: infer Intersection,
) => void
  ? Intersection
  : never;

/** A parsed statement node: one optional member per statement kind (`{ SelectStmt: ... }`). */
export type PgStatementNode = Partial<UnionToIntersection<PgNode>>;

export interface ParseErrorInfo {
  message: string;
  line: number;
  column: number;
}

export interface PgStatement {
  node: PgStatementNode | null;
  kind: string | null;
  start: number;
  end: number;
  line: number;
  column: number;
  text: string;
  /** Converts a node `location` (UTF-8 byte offset inside this statement) to a file position. */
  locate: (nodeLocation: number) => SourcePosition;
  error?: ParseErrorInfo;
}

export type ExplainCandidate =
  | { error: ParseErrorInfo }
  | { kind: string | null; hasInto: boolean; hasLockingClause: boolean; hasDataModifyingCte: boolean };
