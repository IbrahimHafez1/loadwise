import type { Finding, SkippedFile } from '../types.js';
import type { PillarName } from './pillar-name.js';

export type FormatPillar = PillarName;

/**
 * Every `--format` value; text and json are printed by each checker, the rest are rendered from its
 * report.
 */
export type OutputFormat = 'text' | 'json' | 'sarif' | 'github';

export type FindingLevel = 'error' | 'warning' | 'note';

/** The findings of one checker run as `--json` prints them. */
export interface FormatReport {
  findings: Finding[];
  skippedFiles?: readonly SkippedFile[];
}

/** One pillar's report; a null report stands for a checker that did not run. */
export interface ReportEntry {
  pillar: FormatPillar;
  root: string;
  repositoryDirectory?: string;
  report: FormatReport | null | undefined;
}

/** A report entry whose checker ran. */
export type RanReportEntry = ReportEntry & { report: FormatReport };

/** Maps a finding's file to a path relative to the repository root. */
export type RepositoryPath = (file: string | undefined) => string;
