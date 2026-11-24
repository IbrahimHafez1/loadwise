// @ts-check
// The report of a source checker (perf or sec): finding ids, contextual selection, changed-line filtering, site
// fixes and examples, then text or JSON output and the exit code. `pillar` is { command, contractRules }: the
// loadwise subcommand printed in fix commands and the rule ids that `--fail-on contract` enforces.
import path from 'node:path';
import { quoteArgument } from './shell-argument.cjs';
import { filterMinImpact, sortByImpactWithinFiles } from './impact-levels.cjs';
import { applyBaselineOptions, baselineNoteLines } from './baseline.cjs';
import { resolveFormat, renderReports } from './formats/index.cjs';
import { impactByRule } from '../security/rule-ids.cjs';
import type { Finding } from './types.cjs';
import type { BaselineFiltered } from './types/baseline.cjs';
import type { OutputFormat } from './types/report-formats.cjs';
import type {
  FixCommandValues,
  SourceReportPillar,
  SourceReportResult,
  SourceReportValues,
} from './types/source-report.cjs';
import { findProjectRoot } from '../performance/schema/context.cjs';
import { assignFindingIds as assignFindingIdsFindingIds } from '../performance/finding-ids.cjs';
import { keepChangedFindings } from '../performance/changed-lines.cjs';
import { attachExample, printFindings, findingLabel } from '../performance/finding-text.cjs';
import type * as ReviewContext from '../performance/review-context.cjs';
import type * as SiteFix from '../performance/site-fix.cjs';

type LinePrinter = (line: string) => void;

// Ids hash paths relative to the project root, so they match whichever folder the check runs from.
function findingRoot(project?: string): string {
  return findProjectRoot(path.resolve(project ?? '.'));
}

function assignFindingIds(findings: Finding[], root: string): void {
  assignFindingIdsFindingIds(findings, root);
}

function selectFindings(result: SourceReportResult, values: SourceReportValues): Finding[] {
  if (values.settings) result.findings = values.settings.apply(result.findings, process.cwd());
  result.findings = result.findings.filter((finding: Finding) => !values.ignore.includes(finding.ruleId));
  if (values['include-contextual'] !== undefined) {
    const reviewContext: typeof ReviewContext = require('../performance/review-context.cjs');
    const classifyTestWrite = reviewContext.createTestWriteClassifier();
    let contextualCount = 0;
    result.findings = result.findings.filter((finding: Finding) => {
      const reason = finding.contextualReason || classifyTestWrite(finding.file ?? '', finding.ruleId);
      if (!reason) return true;
      finding.contextualReason = reason;
      contextualCount++;
      return values['include-contextual'];
    });
    if (contextualCount) result.contextualFindingCount = contextualCount;
  }
  for (const finding of result.findings) finding.impactLevel ??= impactByRule[finding.ruleId];
  result.findings = sortByImpactWithinFiles(filterMinImpact(result.findings, values['min-impact']));
  return result.findings;
}

// `print` receives each output line; the shared perf and sec run collects them per pillar.
function printResult(
  result: SourceReportResult,
  values: SourceReportValues,
  pillar: SourceReportPillar,
  print: LinePrinter = console.log,
): number {
  // Ids are assigned before filtering, so collision suffixes do not depend on which findings are
  // shown.
  const idRoot = findingRoot(values.project);
  assignFindingIds(result.findings, idRoot);
  selectFindings(result, values);
  if (values.changedLines) {
    const sourceFindings = result.findings.filter(({ ruleId }: Finding) => ruleId !== 'dependency-known-vulnerability');
    const dependencies = result.findings.filter(({ ruleId }: Finding) => ruleId === 'dependency-known-vulnerability');
    result.findings = [...keepChangedFindings(sourceFindings, values.changedLines), ...dependencies];
  }
  const format = resolveFormat(values);
  const baseline = applyBaselineOptions({
    options: values.baselineOptions ?? {},
    pillar: 'security',
    findings: result.findings,
    projectRoot: values.projectDirectory,
    absoluteFileOf: (finding: Finding) => path.resolve(finding.file ?? ''),
    idRoot,
  });
  if (baseline && 'written' in baseline) {
    const message = `Wrote ${baseline.written} finding(s) to ${path.relative(process.cwd(), baseline.file) || baseline.file}.`;
    (format === 'text' ? print : console.error)(message);
    return 0;
  }
  if (baseline) {
    result.findings = baseline.findings;
    result.baselineHidden = baseline.hidden;
    result.baselineStale = baseline.stale;
  }
  const isContract = ({ ruleId }: Finding): boolean => pillar.contractRules.has(ruleId);
  const contractOnly = values['fail-on'] === 'contract';
  if (contractOnly) {
    result.contractFindingCount = result.findings.filter(isContract).length;
  }
  const siteFix: typeof SiteFix = require('../performance/site-fix.cjs');
  siteFix.attachSiteFixes(result.findings);
  for (const finding of result.findings) {
    finding.fixable = Boolean(finding.fix);
    attachExample(finding);
  }
  printSourceReport(result, values, baseline, format, print);
  const exitCount =
    values.settings?.exitCount(result.findings, contractOnly ? isContract : undefined) ??
    (contractOnly ? result.contractFindingCount : result.findings.length);
  return exitCount ? 1 : 0;
}

function printSourceReport(
  result: SourceReportResult,
  values: SourceReportValues,
  baseline: BaselineFiltered | undefined,
  format: OutputFormat,
  print: LinePrinter,
): void {
  if (format === 'json') print(JSON.stringify(result, null, values.watch ? 0 : 2));
  else if (format !== 'text') {
    const output = renderReports(format, [
      { pillar: 'security', root: process.cwd(), repositoryDirectory: values.projectDirectory, report: result },
    ]);
    if (output) print(output);
  } else if (values.changedLines) printChangedFindings(result.findings, values.fixCommand, print);
  else printTextSummary(result, values, print);
  if (format === 'text') {
    if (baseline) for (const line of baselineNoteLines(baseline)) print(line);
    const warningNote = values.settings?.warningNote(result.findings);
    if (warningNote && !values.changedLines) print(warningNote);
  }
}

function printTextSummary(result: SourceReportResult, values: SourceReportValues, print: LinePrinter): void {
  printFindings(result.findings, values.fixCommand, print);
  const summary = `${result.scannedFiles} file(s) checked, ${result.findings.length} finding(s)`;
  print(
    values['fail-on'] === 'contract'
      ? `${summary}, ${result.contractFindingCount} enforced by --fail-on contract.`
      : summary + '.',
  );
  if (result.contextualFindingCount && !values['include-contextual']) {
    print(`${result.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
  }
  const fixableIds = result.findings
    .filter((finding: Finding) => finding.fixable && !finding.fix?.requiresReview)
    .map((finding: Finding) => finding.id);
  if (values.fixCommand && fixableIds.length) {
    print(`Fix all: ${values.fixCommand} --fix --only ${fixableIds.join(',')}`);
  }
}

// Env files, Dockerfiles and compose files comment with #; source files with //.
const hashCommentFile = /(?:^|\/)(?:\.env[^/]*|[^/]*Dockerfile[^/]*|[^/]*\.ya?ml)$/i;

function dismissCommentPrefix(file: string | undefined): string {
  return hashCommentFile.test(file ?? '') ? '#' : '//';
}

// Terse form for commits: where it is, what it says, then the exact command to fix or dismiss it.
function printChangedFindings(findings: Finding[], fixCommand: string | undefined, print: LinePrinter): void {
  for (const finding of findings) {
    print(`${finding.file}:${finding.line} ${findingLabel(finding)} ${finding.impactLevel}: ${finding.message}`);
    if (finding.fixable) print(`  fix:     ${fixCommand} --fix --only ${finding.id}`);
    print(`  dismiss: ${dismissCommentPrefix(finding.file)} loadwise-reviewed ${finding.ruleId} -- <reason>`);
  }
  const fixableIds = findings
    .filter((finding: Finding) => finding.fixable && !finding.fix?.requiresReview)
    .map((finding: Finding) => finding.id);
  if (fixableIds.length > 1) print(`Fix all: ${fixCommand} --fix --only ${fixableIds.join(',')}`);
  print(
    findings.length
      ? `${findings.length} new finding(s) in changed lines. Apply fixes, then \`git add\` the files and commit again.`
      : 'No new findings in changed lines.',
  );
}

// The same inputs make `--fix --only` rescan what was reported, so the ids it is given still match.
function fixAllCommand(
  command: string,
  project: string | undefined,
  files: readonly string[],
  values: FixCommandValues,
): string {
  const inputs: string[] = [];
  if (project !== undefined) inputs.push('-p', project);
  for (const name of values.workspace) inputs.push('--workspace', name);
  if (values.policy) inputs.push('--policy', values.policy);
  if (values['loadwise-config']) inputs.push('--loadwise-config', values['loadwise-config']);
  if (command === 'perf') {
    if (values.schema) inputs.push('--schema', values.schema);
    const engine = values.with === 'sec' ? 'js' : values.native ? 'native' : values.engine;
    if (engine) inputs.push('--engine', engine);
  }
  inputs.push(...files.map((file) => (file.startsWith('-') ? './' + file : file)));
  return [`npx loadwise ${command}`, ...inputs.map(quoteArgument)].join(' ');
}

export { findingRoot, assignFindingIds, selectFindings, printResult, fixAllCommand };
