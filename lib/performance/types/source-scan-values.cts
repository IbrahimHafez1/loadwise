import type { baselineForScan } from '../../shared/baseline.cjs';
import type { loadSettings } from '../../shared/config.cjs';
import type { ChangedLines } from '../changed-lines.cjs';
import type { SourceCheckValues } from './source-check-values.cjs';

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
