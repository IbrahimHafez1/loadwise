import type { AstGrepMatch, AstGrepPosition } from '../../performance/types/ast-grep-match.js';
import type { LocatedFinding } from './module-graph.js';

/** A parser match that also carries where it ends, which the duplicate-body rule reads. */
export interface SpannedMatch extends AstGrepMatch {
  range: AstGrepMatch['range'] & { end: AstGrepPosition };
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** Collects identical function bodies across files and reports each group once. */
export interface DuplicateIndex {
  add(language: string, file: string, match: SpannedMatch): void;
  findings(): LocatedFinding[];
}

/** A file the parser rejected or could not verify; it is skipped and listed. */
export interface UnparsableFile {
  file: string;
  parseError: string;
}

export interface PolyglotAnalysis {
  findings: LocatedFinding[];
  languageCounts: Record<string, number>;
  unparsable: UnparsableFile[];
}
