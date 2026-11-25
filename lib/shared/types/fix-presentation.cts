import type * as TsType from 'typescript';
import type { Node, SourceFile, StringLiteral } from 'typescript';
import type { Finding, FindingFix, FixChange, LoadedFile } from '../types.cjs';
import type { CommentableEdit } from './fix-hunks.cjs';

export type TypeScript = typeof TsType;

/** What the rule tables of a checker say about its rules. */
export interface RuleDescriptions {
  impactByRule: Readonly<Record<string, string>>;
  descriptionByRule: Readonly<Record<string, string>>;
}

/** The text of a file as the why-comment code reads it: parsed, with its line offsets. */
export type ParsedSource = Pick<LoadedFile, 'text' | 'lineStarts'> & { sourceFile: SourceFile };

/**
 * What owns rows of a file: a change's key while formatting a whole run, the change itself when
 * each write is tracked.
 */
export type Owner = string | FixChange;

/**
 * A run of rows: unchanged original rows, or rows written by `owners` that replaced
 * `originalLength` original rows.
 */
export interface RowSegment {
  length: number;
  originalLength: number;
  owners?: Set<Owner>;
}

export interface OwnedRange {
  start: number;
  end: number;
  owners: Set<Owner>;
}

/** `[first, beforeEnd)` of the old rows became `[first, afterEnd)` of the new ones. */
export interface RowRegion {
  first: number;
  beforeEnd: number;
  afterEnd: number;
}

/** Rows `[start, end)` that changes wrote, with the rows they replaced. */
export interface StyleRegion {
  start: number;
  end: number;
  beforeRows: readonly string[];
}

/** A file whose row ranges `[start, end)` are formatted, each range in turn. */
export interface FormatFile {
  file: string;
  text: string;
  ranges: readonly (readonly [number, number])[];
}

export interface FormatRequest {
  root: string;
  files: FormatFile[];
}

export interface FormatOutput {
  missing?: boolean;
  results?: { file: string; steps: string[] }[];
}

/** The parts of Prettier's API this file calls. */
export interface PrettierApi {
  getFileInfo(
    file: string,
    options: { ignorePath: string },
  ): Promise<{ ignored: boolean; inferredParser: string | null }>;
  resolveConfig(file: string, options: { editorconfig: boolean }): Promise<Record<string, unknown> | null>;
  format(text: string, options: Record<string, unknown>): Promise<string>;
}

/**
 * A change written by the per-checker `--fix`, with the record that gets the formatted text
 * afterwards.
 */
export type WrittenChange = FixChange & { owner: FixChange };

export interface WriteTracker {
  recordWrites(changes: readonly WrittenChange[]): void;
  rebase(fix: FindingFix, absolute: (file: string) => string): FindingFix;
  format(root: string): void;
}

export interface WhyCommentInput {
  ruleId: string;
  entry: LoadedFile | undefined;
  edits: CommentableEdit[] | undefined;
  findingOffset: number;
  separateEdits?: boolean;
}

export interface WhyCommentResult {
  edits: CommentableEdit[] | undefined;
  comment?: string;
  row?: number;
}

export interface CommentedEdits {
  edits: CommentableEdit[];
  row: number;
}

export interface ChangedRowRange {
  finding: Finding;
  key: string;
  start: number;
  end: number;
}

/** Rows `[start, end)` that differ between two texts, as a line hunk. */
export interface LineHunk {
  start: number;
  end: number;
  rows: string[];
}

export interface FileStyle {
  insideText: Set<number>;
  statements: Node[];
  strings: StringLiteral[];
  semicolons: boolean | undefined;
  quote: string | undefined;
  indentation: string | undefined;
}

export interface IndentedRow {
  row: number;
  indentation: string;
  extra: string;
}

export interface FormatSide {
  source: SourceFile;
  text: string;
  children: Node[];
}
