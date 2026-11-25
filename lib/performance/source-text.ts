import { baselineNoteLines } from '../shared/baseline.js';
import type { Finding, PackageScope } from '../shared/types.js';
import type { SourceCheckValues } from './types/source-check-values.js';
import { printFindings, findingLabel } from './finding-text.js';

type PrintLine = (line: string) => void;

interface FindingGroup {
  title: string;
  findings: Finding[];
}

/** The result a source check prints. */
interface SourceReport {
  scannedFiles: number;
  findings: Finding[];
  packages?: PackageScope[];
  contractFindingCount?: number;
  contextualFindingCount?: number;
}

/**
 * What baselineNoteLines summarises: hidden findings, and stale entries (null when a partial scan
 * cannot tell).
 */
interface BaselineSummary {
  hidden: number;
  stale: number | null;
}

// One titled group per monorepo package that has findings; the innermost package owns a nested
// folder's files. A single package or a plain project prints one untitled group.
function findingGroups({ findings, packages }: SourceReport): [string | undefined, Finding[]][] {
  if (!packages) return [[undefined, findings]];
  const owners = [...packages].sort((left, right) => right.directory.length - left.directory.length);
  const groups = new Map<string, FindingGroup>(
    packages.map(({ name, directory }) => [directory, { title: `${name} (${directory})`, findings: [] }]),
  );
  const unowned: FindingGroup = { title: 'other files', findings: [] };
  for (const finding of findings) {
    const owner = owners.find(({ directory }) => directory === '.' || finding.file?.startsWith(directory + '/'));
    (owner ? groups.get(owner.directory) : unowned)?.findings.push(finding);
  }
  return [...groups.values(), unowned]
    .filter((group) => group.findings.length)
    .map((group): [string, Finding[]] => [group.title, group.findings]);
}

function printFullReport(
  result: SourceReport,
  values: Partial<Pick<SourceCheckValues, 'fixCommand' | 'fail-on' | 'include-contextual'>>,
  baseline: BaselineSummary | undefined,
  print: PrintLine,
): void {
  for (const [title, findings] of findingGroups(result)) {
    if (title) print(`-- ${title} --`);
    printFindings(findings, values.fixCommand, print);
  }
  const summary = `${result.scannedFiles} file(s) checked, ${result.findings.length} finding(s)`;
  print(
    values['fail-on'] === 'contract'
      ? `${summary}, ${result.contractFindingCount} enforced by --fail-on contract.`
      : summary + '.',
  );
  if (result.contextualFindingCount && !values['include-contextual']) {
    print(`${result.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
  }
  if (baseline) for (const line of baselineNoteLines(baseline)) print(line);
  const fixableIds = result.findings
    .filter((finding: Finding) => finding.fixable && !finding.fix?.requiresReview)
    .map((finding: Finding) => finding.id);
  if (values.fixCommand && fixableIds.length) {
    print(`Fix all: ${values.fixCommand} --fix --only ${fixableIds.join(',')}`);
  }
}

// Terse form for commits: where it is, what it says, then the exact command to fix or dismiss it.
function printChangedFindings(findings: Finding[], fixCommand: string | undefined, print: PrintLine): void {
  for (const finding of findings) {
    print(`${finding.file}:${finding.line} ${findingLabel(finding)} ${finding.impactLevel}: ${finding.message}`);
    if (finding.fixable) print(`  fix:     ${fixCommand} --fix --only ${finding.id}`);
    print(`  dismiss: // loadwise-reviewed ${finding.ruleId} -- <reason>`);
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

export type { BaselineSummary, SourceReport };
export { printFullReport, printChangedFindings };
