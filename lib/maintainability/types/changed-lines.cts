/** First and last changed line, one-based and inclusive. */
export type LineRange = [start: number, end: number];

/** Project-relative file to the line ranges changed on its new side. */
export type ChangedRanges = Map<string, LineRange[]>;

/** Which diff `--staged` or `--changed-since` selects. */
export interface ChangeSelection {
  staged?: boolean;
  since?: string;
}
