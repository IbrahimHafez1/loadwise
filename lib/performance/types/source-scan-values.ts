import type { baselineForScan } from '../../shared/baseline.js';
import type { loadSettings } from '../../shared/config.js';
import type { ChangedLines } from '../changed-lines.js';
import type { SourceCheckValues } from './source-check-values.js';

export type ScanSettings = ReturnType<typeof loadSettings>;

/** The parsed flags plus what a scan adds to them before reporting. */
export interface SourceScanValues extends SourceCheckValues {
  settings: ScanSettings;
  projectDirectory?: string;
  baselineOptions?: ReturnType<typeof baselineForScan>;
  changedLines?: ChangedLines;
}

/** The lines a `--staged` or `--changed-since` scan restricts reporting to. */
export interface ChangedScope {
  changedLines: ChangedLines;
  isChangedFile(filename: string): boolean;
}
