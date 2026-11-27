/** A project's private review-history directory and the project root it belongs to. */
export interface HistoryStorage {
  root: string;
  directory: string;
}

/** A reviewer's decision about one finding, saved to review history. */
export interface ReviewOutcome {
  id: string;
  checker: string;
  ruleId?: string;
  file?: string;
  line?: number;
  column?: number;
  status: string;
  evidence: string;
}
