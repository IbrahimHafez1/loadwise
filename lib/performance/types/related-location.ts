// Where a finding's `related` entry points: another place the finding is about. Types only.

export interface RelatedLocation {
  file: string;
  line: number;
  column: number;
  message?: string;
}
