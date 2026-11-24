import type { TextEdit } from '../../shared/types.cjs';

/**
 * Edits that move a statement into a named function, with the type check to run once they are
 * wanted.
 */
export interface ExtractionDraft {
  name: string;
  edits: TextEdit[];
  typeChecks(): boolean;
}

/**
 * The rule's value for one function before and after a rewrite; `contained` is false when other
 * functions got worse.
 */
export interface MeasuredEdits {
  before: number;
  after: number;
  contained: boolean;
}
