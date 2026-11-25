/** What a checker run hands the review inbox: the report plus where and how it ran. */
export interface ReviewEvent {
  version: number;
  command: string;
  directory?: string;
  cwd?: string;
  report?: unknown;
  [detail: string]: unknown;
}

/** Where a saved review request can be read back. */
export interface ReviewHandoffReceipt {
  file: string;
  id?: string;
}
