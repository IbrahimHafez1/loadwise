/**
 * An illustrative alternative shown beside a finding when the scanner has no rewrite of the exact
 * code.
 */
export interface FixExample {
  language: string;
  code: string;
  note?: string;
  inline?: string;
  review?: string;
  before?: string;
}
