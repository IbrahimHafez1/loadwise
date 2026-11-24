import path from 'node:path';
import { impactByRule } from './rule-ids.cjs';
import { annotateImpact, filterMinImpact, sortByImpactWithinFiles } from '../shared/impact-levels.cjs';
import { applyBaselineOptions, baselineNoteLines } from '../shared/baseline.cjs';
import { resolveFormat, renderReports } from '../shared/formats/index.cjs';
import { contractRules } from '../shared/formats/contract-rules.cjs';
import { exitCodeWithSkips } from './scan-outcome.cjs';
import type { Finding } from '../shared/types.cjs';
import type { BaselineFiltered } from '../shared/types/baseline.cjs';
import type { SourceCheckValues } from './types/source-check-values.cjs';
import type { ChangedScope, ScanSettings } from './types/source-scan-values.cjs';
import { findProjectRoot } from './schema/context.cjs';
import { assignFindingIds as assignFindingIdsFindingIds } from './finding-ids.cjs';
import { keepChangedFindings, collectProjectChangedLines, fileKey } from './changed-lines.cjs';
import { attachExample } from './finding-text.cjs';
import { printChangedFindings, printFullReport } from './source-text.cjs';
import type * as ReviewContext from './review-context.cjs';
import type * as SiteFix from './site-fix.cjs';
import type { PerformanceScanResult, PillarOutput, PrintLine, PrintValues } from './cli-types.cjs';

// Ids hash paths relative to the project root, so they match whichever folder the check runs from.
export function findingRoot(project: string | undefined): string {
  return findProjectRoot(path.resolve(project ?? '.'));
}

export function assignFindingIds(findings: Finding[], root: string): void {
  assignFindingIdsFindingIds(findings, root);
}

// Ignored files are never scanned, so they cost no time and add nothing to the file count.
export function scanFilter(
  settings: ScanSettings,
  scope: ChangedScope | undefined,
): ((filename: string) => boolean) | undefined {
  const { isIgnored } = settings;
  if (!isIgnored) return scope?.isChangedFile;
  return (filename: string) => !isIgnored(process.cwd(), filename) && (scope?.isChangedFile(filename) ?? true);
}

export function selectFindings(
  result: Pick<PerformanceScanResult, 'findings' | 'contextualFindingCount'>,
  values: PrintValues,
): Finding[] {
  if (values.settings) result.findings = values.settings.apply(result.findings, process.cwd());
  result.findings = result.findings.filter((finding: Finding) => !values.ignore.includes(finding.ruleId));
  if (values['include-contextual'] !== undefined) {
    const reviewContext: typeof ReviewContext = require('./review-context.cjs');
    const classifyTestWrite = reviewContext.createTestWriteClassifier();
    let contextualCount = 0;
    result.findings = result.findings.filter((finding: Finding) => {
      const reason =
        finding.contextualReason ||
        (finding.file === undefined ? undefined : classifyTestWrite(finding.file, finding.ruleId));
      if (!reason) return true;
      finding.contextualReason = reason;
      contextualCount++;
      return values['include-contextual'];
    });
    if (contextualCount) result.contextualFindingCount = contextualCount;
  }
  return result.findings;
}

function isContractFinding({ ruleId }: Pick<Finding, 'ruleId'>): boolean {
  return contractRules.performance.has(ruleId);
}

export function printResult(
  result: PerformanceScanResult,
  values: PrintValues,
  print: PrintLine = console.log,
): number {
  // Ids are assigned before filtering, so collision suffixes do not depend on which findings are
  // shown.
  const idRoot = findingRoot(values.project);
  assignFindingIds(result.findings, idRoot);
  selectFindings(result, values);
  result.findings = sortByImpactWithinFiles(
    filterMinImpact(annotateImpact(result.findings, impactByRule), values['min-impact']),
  );
  if (values.changedLines) {
    result.findings = keepChangedFindings(result.findings, values.changedLines);
  }
  const baseline = applyBaselineOptions({
    options: values.baselineOptions ?? {},
    pillar: 'performance',
    findings: result.findings,
    projectRoot: values.projectDirectory ?? process.cwd(),
    absoluteFileOf: (finding: Finding) => path.resolve(finding.file ?? ''),
    idRoot,
  });
  if (baseline && 'written' in baseline) {
    const message = `Wrote ${baseline.written} finding(s) to ${path.relative(process.cwd(), baseline.file) || baseline.file}.`;
    (resolveFormat(values) === 'text' ? print : console.error)(message);
    return exitCodeWithSkips(result, 0);
  }
  if (baseline) {
    result.findings = baseline.findings;
    result.baselineHidden = baseline.hidden;
    result.baselineStale = baseline.stale;
  }
  const contractOnly = values['fail-on'] === 'contract';
  if (contractOnly) {
    result.contractFindingCount = result.findings.filter(isContractFinding).length;
  }
  const siteFix: typeof SiteFix = require('./site-fix.cjs');
  siteFix.attachSiteFixes(result.findings);
  for (const finding of result.findings) {
    finding.fixable = Boolean(finding.fix);
    attachExample(finding);
  }
  printSourceOutput(result, values, baseline, print);
  return exitCodeWithSkips(
    result,
    values.settings.exitCount(result.findings, contractOnly ? isContractFinding : undefined) ? 1 : 0,
  );
}

function printSourceOutput(
  result: PerformanceScanResult,
  values: PrintValues,
  baseline: BaselineFiltered | undefined,
  print: PrintLine,
): void {
  const format = resolveFormat(values);
  if (format === 'json') print(JSON.stringify(result, null, values.watch ? 0 : 2));
  else if (format !== 'text') printStructured(format, result, values.projectDirectory, print);
  else if (values.changedLines) {
    printChangedFindings(result.findings, values.fixCommand, print);
    if (baseline) for (const line of baselineNoteLines(baseline)) print(line);
  } else {
    printFullReport(result, values, baseline, print);
  }
  const warningNote = values.settings.warningNote(result.findings);
  if (warningNote && format === 'text' && !values.changedLines) print(warningNote);
}

// Finding paths are relative to the working directory.
function printStructured(
  format: string,
  result: PerformanceScanResult,
  repositoryDirectory: string | undefined,
  print: PrintLine,
): void {
  const output = renderReports(format, [
    { pillar: 'performance', root: process.cwd(), repositoryDirectory, report: result },
  ]);
  if (output) print(output);
}

// Reads only the two scope flags, so an empty change set can exit before TypeScript or the SQL
// parser loads.
export function readChangedScope(
  values: SourceCheckValues & { help?: boolean },
  positionals: readonly string[],
): ChangedScope | undefined {
  if (values.help || (!values.staged && values['changed-since'] === undefined)) return undefined;
  if (values.staged && values['changed-since'] !== undefined) {
    throw new Error('Choose either --staged or --changed-since.');
  }
  if (positionals.length || values.watch || values.fix) {
    throw new Error('--staged and --changed-since cannot be combined with explicit files, --watch or --fix.');
  }
  // `check` runs the security checker too, which also reads env, Dockerfile and compose files.
  const allFiles = values.with !== undefined;
  const changedLines = collectProjectChangedLines(
    { staged: values.staged, ref: values['changed-since'], allFiles },
    values.project,
  );
  return { changedLines, isChangedFile: (filename: string) => changedLines.has(fileKey(filename)) };
}

export function printEmptyChangedReport(values: Pick<SourceCheckValues, 'format' | 'json' | 'with'>): void {
  const result = { scannedFiles: 0, findings: [] };
  const format = resolveFormat(values);
  function output(pillar: 'performance' | 'security'): string {
    if (format === 'json') return JSON.stringify(result);
    if (format === 'text') return 'No changed files to check.';
    return renderReports(format, [{ pillar, root: process.cwd(), report: result }]);
  }
  if (values.with === 'sec') {
    const reports: Record<string, PillarOutput> = {};
    for (const pillar of ['performance', 'security'] as const) {
      const rendered = output(pillar);
      reports[pillar] = { code: 0, stdout: rendered ? rendered + '\n' : '' };
    }
    console.log(JSON.stringify(reports));
  } else {
    const rendered = output('performance');
    if (rendered) console.log(rendered);
  }
}
