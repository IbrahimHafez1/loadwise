import type { Finding, SkippedFile } from '../../shared/types.cjs';

/** How a scan is limited and tuned. */
export interface ScanOptions {
  /** The file count from which analysis moves to worker threads. */
  parallelFrom?: number;
  /** Limits the report to files the caller cares about. */
  inScope?: (file: string) => boolean;
  /** Keep each file's identifier index for private-method fixes. */
  indexIdentifiers?: boolean;
}

/** How much of the project a source scan covered. */
export interface SourceCoverage {
  discoveredFiles: number;
  scannedFiles: number;
  dependencyFiles: number;
  placementFiles: number;
  resolvedInternalEdges: number;
  languageCounts: Record<string, number>;
}

/** The result of scanning a project's source files. */
export interface SourceScan extends SourceCoverage {
  mode: 'source';
  findings: Finding[];
  skippedFiles?: SkippedFile[];
  ignoredAllSources?: boolean;
  identifierIndex?: Map<string, string>;
}

/** The result of reading a module graph another tool exported. */
export interface GraphScan {
  mode: 'graph';
  graphFiles: number;
  graphEdges: number;
  findings: Finding[];
  skippedFiles?: SkippedFile[];
}

/**
 * Counts the report adds once findings are filtered, contextual ones are set aside and a baseline
 * is applied.
 */
export interface ReportCounts {
  contextualFindingCount?: number;
  contractFindingCount?: number;
  baselineHidden?: number;
  baselineStale?: number | null;
}

/** What `loadwise maint` prints, from a source scan or a module graph. */
export type MaintainabilityReport = (SourceScan | GraphScan) & ReportCounts;
