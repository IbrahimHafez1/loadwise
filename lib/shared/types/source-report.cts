import type { ScanResult } from '../types.cjs';
import type { BaselineRunOptions } from './baseline.cjs';
import type { LoadwiseSettings } from './settings.cjs';
import type * as ChangedLinesModule from '../../performance/changed-lines.cjs';

/** A source checker's scan result as the shared report prints it. */
export interface SourceReportResult extends ScanResult {
  contextualFindingCount?: number;
  contractFindingCount?: number;
  baselineHidden?: number;
  baselineStale?: number | null;
}

/** The command-line values that decide the fix command a report prints. */
export interface FixCommandValues {
  workspace: readonly string[];
  policy?: string;
  'loadwise-config'?: string;
  schema?: string;
  with?: string;
  native?: boolean;
  engine?: string;
}

/** The changed lines `--staged` and `--changed-since` limit a report to. */
export type ChangedLines = Parameters<typeof ChangedLinesModule.keepChangedFindings>[1];

export interface SourceReportValues {
  settings?: LoadwiseSettings;
  ignore: readonly string[];
  'include-contextual'?: boolean;
  'min-impact'?: string;
  'fail-on'?: string;
  project?: string;
  projectDirectory: string;
  changedLines?: ChangedLines;
  baselineOptions?: BaselineRunOptions;
  fixCommand?: string;
  watch?: boolean;
  format?: string;
  json?: boolean;
}

/**
 * The loadwise subcommand printed in fix commands, and the rule ids `--fail-on contract` enforces.
 */
export interface SourceReportPillar {
  command: string;
  contractRules: ReadonlySet<string>;
}
