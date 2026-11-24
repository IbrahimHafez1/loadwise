import type { Finding } from '../shared/types.cjs';
import type { BaselineRunOptions } from '../shared/types/baseline.cjs';
import type { SourceReportResult, SourceReportValues } from '../shared/types/source-report.cjs';
import type { PerformancePolicy } from './types/performance-policy.cjs';
import type { SourceAnalyzer } from './types/source-analyzer.cjs';
import type { ChangedScope, ScanSettings, SourceScanValues } from './types/source-scan-values.cjs';

export type PrintLine = (line: string) => void;

/**
 * A workspace package as the report names it: its name and its folder relative to the working
 * directory.
 */

interface WorkspacePackageSummary {
  name: string;
  directory: string;
}

/** The packages of a monorepo scan, with the config each is checked with. */

export interface WorkspaceTarget {
  directory: string;
  configs: string[];
  packages: WorkspacePackageSummary[];
}

/** Where a scan reads its policy from, and how to read it again in watch mode. */

export interface PolicySource {
  filename: string;
  read(): PerformancePolicy | undefined;
}

/**
 * What a perf scan produces before it is printed: the shared report fields, the engine and the
 * dependency count.
 */

export interface PerformanceScanResult extends SourceReportResult {
  engine?: string;
  scannedPackages?: number;
}

/** The parsed flags once the scan has added its settings and the folder that names the project. */

export interface ScanValues extends SourceScanValues {
  projectDirectory: string;
}

/**
 * The members of the parsed flags that printing reads; `loadwise perf polyglot` supplies only some
 * of them.
 */

export interface PrintValues extends Omit<SourceReportValues, 'projectDirectory' | 'settings'> {
  settings: ScanSettings;
  projectDirectory?: string;
}

export interface SourceCodeOptions {
  project?: string | string[];
  files: string[];
  policy?: PerformancePolicy;
  onlyFiles?: (filename: string) => boolean;
  analyzers?: SourceAnalyzer[];
}

export interface AnalyzedSource {
  result: PerformanceScanResult;
  usedFallback: boolean;
}

export type FindingsReporter = (result: PerformanceScanResult, values: PrintValues) => Finding[];

export type ExitCodeReporter = (result: PerformanceScanResult, values: PrintValues) => number;

export interface PillarOutput {
  code: number;
  stdout: string;
}

export interface CheckWithSecurityInput {
  values: ScanValues;
  positionals: string[];
  policy: PerformancePolicy | undefined;
  scope: ChangedScope | undefined;
  workspace: WorkspaceTarget | undefined;
  project: string | undefined;
  baselineOptions: BaselineRunOptions;
  inferredFiles: string[] | undefined;
}

export interface ScanSourceInput {
  values: ScanValues;
  positionals: string[];
  workspace: WorkspaceTarget | undefined;
  inferredFiles: string[] | undefined;
  policy: PerformancePolicy | undefined;
  scope: ChangedScope | undefined;
  engine: string;
  report: ExitCodeReporter | FindingsReporter;
}
