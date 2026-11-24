import type { Finding, SkippedFile } from '../../lib/shared/types.cjs';

/** The JSON a `loadwise maint --json` run prints; further report fields are read by name. */
export interface CliReport {
  findings: Finding[];
  skippedFiles?: SkippedFile[];
  languageCounts?: Record<string, number>;
  [field: string]: unknown;
}

export function parseReport(stdout: string): CliReport {
  const report: CliReport = JSON.parse(stdout);
  return report;
}
