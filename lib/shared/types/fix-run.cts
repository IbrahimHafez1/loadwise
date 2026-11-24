import type { Finding, FindingFix } from '../types.cjs';

/** A finding that carries a generated fix. */
export type FixableFinding = Finding & { fix: FindingFix };

/**
 * A file's rows a fix change replaced: `removed` rows of the original from `row` became `added`
 * rows.
 */
export interface UpdateHunk {
  key: string;
  row: number;
  removed: number;
  added: number;
}

/**
 * A file's new text, held until every fix of the run has been checked; `before` is undefined for a
 * created file.
 */
export interface FileUpdate {
  file: string;
  before: string | undefined;
  after: string;
}

export interface HunkedFileUpdate extends FileUpdate {
  hunks: readonly UpdateHunk[];
}

/** One change as it reads in the formatted file. */
export interface FormattedHunk {
  line: number;
  before: string;
  after: string;
}

/** The formatted text by file, and by hunk key each change as it now reads. */
export interface FormattedUpdates {
  texts: Map<string, string>;
  hunks: Map<string, FormattedHunk>;
}
