/**
 * Lines of each reported file by filename; `undefined` marks a file that was missing or outside the
 * workspace.
 */
export type LineCache = Map<string, string[] | undefined>;
