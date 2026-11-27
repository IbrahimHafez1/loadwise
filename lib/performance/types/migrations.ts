// Shared types for migration site fixes (SQL scanning, statement anatomy, context and placement).
import type {
  Block,
  FunctionLikeDeclaration,
  NoSubstitutionTemplateLiteral,
  Node,
  StringLiteral,
  TemplateExpression,
} from 'typescript';
import type { Finding, FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

// How scanning treats the text: whether backslash escapes apply, and whether `${...}` holes are
// skipped.
export interface ScanOptions {
  escapes: boolean;
  holes: boolean;
}

// A statement's offsets in the file text; `semicolon` is the offset of its `;`, null for the last
// one without.
export interface StatementRange {
  start: number;
  end: number;
  semicolon: number | null;
}

// A statement with its decoded SQL, and that SQL with strings and comments blanked.
export interface SqlStatement extends StatementRange {
  sql: string;
  masked: string;
}

// One comma-separated sub-command of an ALTER TABLE, as offsets into the statement SQL.
export interface SubcommandRange {
  start: number;
  end: number;
}

export interface AlterParts {
  table: string;
  subcommands: SubcommandRange[];
}

// A match of a regex with the `d` flag, which carries the offsets of each group.
export type IndexedMatch = RegExpExecArray & { indices: RegExpIndicesArray };

export type QueryLiteral = StringLiteral | NoSubstitutionTemplateLiteral | TemplateExpression;

// Where the flagged statement is and what runs it. The statement fields stay empty until the query
// literal is found.
export interface MigrationContext {
  finding: Finding;
  node: Node | undefined;
  sourceFile: SiteFixInput['sourceFile'];
  text: string;
  load: SiteFixInput['load'];
  offset: number;
  eol: string;
  file: string;
  framework: string;
  /** The quote character of the query literal; null in a .sql file. */
  quote: string | null;
  regionStart: number;
  regionEnd: number;
  literal?: QueryLiteral;
  statements: SqlStatement[];
  statement?: SqlStatement;
  relativeOffset: number;
}

// The replacement SQL of one rule, and how to write it back.
export interface PlacementPlan {
  sqls: string[];
  outsideTransaction?: boolean;
  note?: string;
}

// Edits that take a code migration out of its default transaction.
export interface TransactionEdit {
  edits: TextEdit[];
  note?: string;
}

export type BlockBodyFunction = FunctionLikeDeclaration & { body: Block };

export type Notes = (string | false | null | undefined)[];

export type MigrationRule = (context: MigrationContext) => FixResult | undefined;
