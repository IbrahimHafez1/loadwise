/**
 * One dismissed finding: a file and rule, and the trimmed flagged line unless the whole file is
 * dismissed.
 */
export interface DismissalEntry {
  file: string;
  ruleId: string;
  lineText?: string | null;
}

export interface Dismissals {
  entries(): DismissalEntry[];
  has(site: DismissalEntry): boolean;
  add(entry: DismissalEntry): Promise<void>;
  remove(removed: readonly DismissalEntry[]): Promise<void>;
  /** Re-reads the file after another editor or a checkout changed it. */
  reload(): void;
}
