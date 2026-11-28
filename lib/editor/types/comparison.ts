import type { SourcePosition } from './source-document.js';

/** A before and after the editor can place in a hover or an inline preview. */
export interface CodeComparison {
  kind: 'source' | 'illustration';
  before: string;
  after: string;
  language?: string;
  note?: string;
  inline?: string;
  message?: string;
}

/** A finding with no rewrite: the flagged line and a one-line suggestion. */
export interface ReviewComparison {
  kind: 'review';
  before: string;
  inline: string;
  note?: string;
}

export type Comparison = CodeComparison | ReviewComparison;

/** A rewrite of the exact flagged code, taken from the source file. */
export interface SourceRewrite {
  before?: string;
  code: string;
  language?: string;
  note: string;
  inline?: string;
}

/** A saved comparison once its fields have been checked. */
export interface SavedExcerpt {
  line: number;
  before: string;
  code: string;
  inline: string;
  note: string;
}

/** What the comparison modules read of a finding's diagnostic. */
export interface FindingDiagnostic {
  source?: string;
  code?: string;
  message?: string;
  /** Saved on the finding by a scanner, so untrusted until checked. */
  suggestion?: unknown;
  comparison?: unknown;
  range: { start: SourcePosition };
}
