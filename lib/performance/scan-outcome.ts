import type { Finding, ScanResult, SkippedFile } from '../shared/types.js';
import type { ChangedScope, SourceScanValues } from './types/source-scan-values.js';
import { fixAllCommand } from '../shared/fix-command.js';

interface SourceResultInput {
  result: ScanResult;
  usedFallback: boolean;
  values: SourceScanValues;
  project: string | undefined;
  baselineOptions: SourceScanValues['baselineOptions'];
  positionals: readonly string[];
  scope: ChangedScope | undefined;
  // A caller of checkCode may ask for the findings instead of an exit code.
  report: (result: ScanResult, values: SourceScanValues) => number | Finding[] | Promise<number | Finding[]>;
}

function noteEmptyIgnoredScan(result: ScanResult, values: SourceScanValues, scope: ChangedScope | undefined): void {
  // TypeScript rejects a project with no inputs, but one emptied by ignore globs scans nothing
  // without complaint.
  if (scope || !values.settings.isIgnored || result.scannedFiles !== 0) return;
  console.error(
    `Note: every source file matches "ignore" in ${values.settings.filename}; no files were left to check.`,
  );
}

// A skipped file is coverage the report lacks, so it is listed once and the run can never look like
// a pass.
function recordSkippedFile(skippedFiles: SkippedFile[], { file, reason }: SkippedFile, note: string): void {
  if (skippedFiles.some((skipped) => skipped.file === file && skipped.reason === reason)) return;
  skippedFiles.push({ file, reason });
  console.error('Note: ' + note);
}

const invalidInputExitCode = 2;

function exitCodeWithSkips(result: Pick<ScanResult, 'skippedFiles'>, code: number): number {
  return result.skippedFiles?.length ? invalidInputExitCode : code;
}

function reportSourceResult({
  result,
  usedFallback,
  values,
  project,
  baselineOptions,
  positionals,
  scope,
  report,
}: SourceResultInput): number | Finding[] | Promise<number | Finding[]> {
  const reportValues = {
    ...values,
    project,
    baselineOptions,
    fixCommand: fixAllCommand('perf', project, positionals, usedFallback ? { ...values, engine: 'js' } : values),
  };
  return report(result, scope ? { ...reportValues, changedLines: scope.changedLines } : reportValues);
}

async function editorAnalyzers() {
  const [{ performanceAnalyzers }, { analyzer }] = await Promise.all([
    import('./projects.js'),
    import('../security/cli.js'),
  ]);
  return [...performanceAnalyzers, analyzer];
}

export { editorAnalyzers, exitCodeWithSkips, noteEmptyIgnoredScan, recordSkippedFile, reportSourceResult };
