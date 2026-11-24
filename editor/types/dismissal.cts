/**
 * One dismissed finding: a file and rule, and the trimmed flagged line unless the whole file is
 * dismissed.
 */
export interface DismissalEntry {
  file: string;
  ruleId: string;
  lineText?: string | null;
}

/** The workspace state the dismissals are saved in. */
export interface Memento {
  get<Value>(key: string, fallback: Value): Value;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface Dismissals {
  entries(): DismissalEntry[];
  has(site: DismissalEntry): boolean;
  add(entry: DismissalEntry): PromiseLike<void>;
  remove(removed: readonly DismissalEntry[]): PromiseLike<void>;
}
