/** A before/after rewrite shown with a finding to explain a suggested restructuring. */
export interface FindingComparison {
  line: number;
  before: string;
  code: string;
  inline: string;
  note: string;
  language: 'javascript' | 'typescript';
}
