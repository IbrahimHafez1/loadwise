import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { exampleFor } from './examples.js';
import { impactByRule } from './rule-ids.js';
import { annotateImpact, filterMinImpact, parseMinImpact, sortByImpactWithinFiles } from '../shared/impact-levels.js';
import { fixLines } from './fix-text.js';
import { loadSettings } from '../shared/config.js';
import { extractBaselineFlags } from '../shared/baseline-flags.js';
import { resolveFormat, renderReports } from '../shared/formats/index.js';
import { contractRules } from '../shared/formats/contract-rules.js';
import { quoteArgument } from '../shared/shell-argument.js';
import { exitCodeWithSkips } from '../performance/scan-outcome.js';
import type { ImpactLevel, Finding } from '../shared/types.js';
import type { BaselineFiltered, BaselineWritten } from '../shared/types/baseline.js';
import type { BaselineFlagOptions } from '../shared/types/baseline.js';
import type { OutputFormat } from '../shared/types/report-formats.js';
import type { LoadwiseSettings } from '../shared/types/settings.js';
import type { ChangedRanges } from './types/changed-lines.js';
import type { SourceLocation } from './types/polyglot-scan.js';
import type { MaintainabilityPolicy } from './types/policy.js';
import type { GraphScan, MaintainabilityReport, SourceScan } from './types/scan-report.js';
import { readChangedRanges, filterToChangedLines } from './changed-lines.js';
import { enableCompileCache } from 'node:module';
import { assignFindingIds } from './finding-ids.js';
import { findingReason, groupByReason } from '../shared/reason-groups.js';
import { notifyEditor } from '../shared/notify-editor.js';

// The command-line values `loadwise maint` reads.
interface ScanValues {
  help?: boolean;
  json?: boolean;
  format?: string;
  config?: string;
  'loadwise-config'?: string;
  ignore: string[];
  graph?: string;
  'include-contextual'?: boolean;
  'fail-on'?: string;
  'min-impact'?: string;
  staged?: boolean;
  'changed-since'?: string;
  fix?: boolean;
  yes?: boolean;
  only: string[];
  comments?: boolean;
  'no-comments'?: boolean;
  'no-format'?: boolean;
  workspace: string[];
}

interface HelpRequest {
  help: true;
}

interface ParsedScanOptions {
  help?: undefined;
  values: ScanValues;
  directory: string | undefined;
  format: OutputFormat;
  minImpact: ImpactLevel | undefined;
  failOn: string;
  baselineOptions: BaselineFlagOptions;
  onlyIds: string[];
}

type InScope = (file: string) => boolean;

interface ScanProjectResult {
  report: MaintainabilityReport;
  policy: MaintainabilityPolicy;
  settings: LoadwiseSettings;
  identifierIndex: Map<string, string> | undefined;
}

interface TextReportContext {
  directory: string | undefined;
  values: ScanValues;
  baseline: BaselineFiltered | undefined;
  settings: LoadwiseSettings;
  policy: MaintainabilityPolicy;
}

interface PrintContext extends TextReportContext {
  root: string;
  format: OutputFormat;
  changes: ChangedRanges | undefined;
}

const help = `Usage:
  loadwise maint [directory] [--config policy.json] [--loadwise-config loadwise.config.json] [--workspace name|path ...] [--ignore rule-id] [--json | --format text|json|sarif|github] [--include-contextual] [--fail-on contract|all] [--min-impact low|medium|high|critical] [--baseline [file] | --write-baseline [file]]
  loadwise maint [directory] [--config policy.json] [--include-contextual] --fix [--yes | --only id,...] [--no-comments] [--no-format]
  loadwise maint agent init [--mode ask|auto] [--hook [block|warn|off]]
  loadwise maint [directory] (--staged | --changed-since <git-ref>) [--json] [--fix --only id,...]
  loadwise maint [directory] --graph modules.json [--config policy.json] [--json]

A loadwise.config.json in the directory also applies: its "maintainability" section holds the policy (--config names a policy file instead), and its ignore, rules and overrides filter the findings; --loadwise-config names another file. --ignore drops a rule's findings.
The default directory is the current folder. Source mode discovers supported files.
Graph mode accepts project-relative files and dependency edges from any language.
Findings with a safe rewrite carry it as a diff, and as "fix" in --json output.
--fix shows each available code fix and asks before applying it; --fix --yes applies every one without asking.
If a selected fix can no longer be applied, the command exits 2. Rerun the scan to refresh the fixes.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
--fix adds a "// Loadwise <rule-id>: <why>" comment above each fixed statement and formats the changed lines with the project's Prettier; --no-comments and --no-format turn these off.
Every finding has a stable id (shown as #id); a failed --only id exits 2.
Changed-lines mode: --staged reports only findings on lines added or changed in the git index; --changed-since <git-ref> does the same against that ref.
Only changed files are analysed there (duplicate-implementation and cycles through unchanged files are skipped unless many files changed, which runs the full scan), and --fail-on defaults to all.
agent init writes one block of instructions for AI coding agents, covering every checker, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
--write-baseline records the current findings in loadwise-baseline.json at the project root (or the given file); --baseline hides them so only new findings are reported and reports how many were hidden.
The baseline file has one section per checker, shared with loadwise perf and loadwise check; entries are matched by rule, file and flagged code, not line number.
Add "// loadwise-reviewed <rule-id> -- <reason>" on the line above a finding to mark it as reviewed.
--min-impact reports only findings at that impact level or above; the rest do not count toward the exit code.
By default, only declared folder or query contracts fail CI. Exit codes are 0, 1 (threshold met), 2 (invalid input).`;

// Prints each rule's example once so output stays short when many findings share a rule.
function printFixOnce(ruleId: string, printedRules: Set<string>): void {
  const example = exampleFor(ruleId);
  if (!example || printedRules.has(ruleId)) return;
  printedRules.add(ruleId);
  console.log('  Fix:');
  for (const line of example.before) console.log('    - ' + line);
  for (const line of example.after) console.log('    + ' + line);
}

// Additive field: existing consumers ignore it.
function addExample(finding: Finding): void {
  const example = exampleFor(finding.ruleId);
  if (example) finding.example = example;
}

// The same directory and policy make `--fix --only` rescan what was reported, so the ids it is
// given still match.
function fixAllCommand(directory: string | undefined, values: ScanValues): string {
  const inputs = [
    ...(directory && directory !== '.' ? [directory] : []),
    ...(values.config === undefined ? [] : ['--config', values.config]),
    ...(values['loadwise-config'] === undefined ? [] : ['--loadwise-config', values['loadwise-config']]),
    ...values.workspace.flatMap((workspace: string) => ['--workspace', workspace]),
    ...values.ignore.flatMap((rule: string) => ['--ignore', rule]),
    ...(values.staged ? ['--staged'] : []),
    ...(values['changed-since'] === undefined ? [] : ['--changed-since', values['changed-since']]),
  ];
  return ['npx loadwise maint', ...inputs.map(quoteArgument)].join(' ');
}

// Read git before loading TypeScript when no supported source changed.
function readChanges(root: string, values: ScanValues): ChangedRanges | undefined {
  if (!values.staged && values['changed-since'] === undefined) return undefined;
  if (values.staged && values['changed-since'] !== undefined)
    throw new Error('Pass --staged or --changed-since, not both.');
  if (values.graph !== undefined) throw new Error('--staged and --changed-since cannot be combined with --graph.');
  return readChangedRanges(root, {
    staged: values.staged,
    since: values['changed-since'],
  });
}

// Folders of the --workspace packages, relative to the scanned root, or undefined when no package
// was chosen.
async function selectedWorkspaceFolders(root: string, selectors: readonly string[]): Promise<string[] | undefined> {
  if (!selectors.length) return undefined;
  const { discoverWorkspaces, selectWorkspaces } = await import('../shared/workspaces.js');
  const { packages, withoutConfig } = discoverWorkspaces(root);
  const chosen = selectWorkspaces([...packages, ...withoutConfig], root, selectors);
  return chosen.map(({ directory }) => path.relative(root, directory).split(path.sep).join('/'));
}

function parseScanOptions(args: string[]): HelpRequest | ParsedScanOptions {
  const { args: checkerArgs, ...baselineOptions } = extractBaselineFlags(args);
  const { values, positionals } = parseArgs({
    args: checkerArgs,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      format: { type: 'string' },
      config: { type: 'string' },
      'loadwise-config': { type: 'string' },
      ignore: { type: 'string', multiple: true, default: [] },
      graph: { type: 'string' },
      'include-contextual': { type: 'boolean' },
      'fail-on': { type: 'string' },
      'min-impact': { type: 'string' },
      staged: { type: 'boolean' },
      'changed-since': { type: 'string' },
      fix: { type: 'boolean' },
      yes: { type: 'boolean' },
      only: { type: 'string', multiple: true, default: [] },
      comments: { type: 'boolean' },
      'no-comments': { type: 'boolean' },
      'no-format': { type: 'boolean' },
      workspace: { type: 'string', multiple: true, default: [] },
    },
  });
  const onlyIds = values.only
    .flatMap((list: string) => list.split(','))
    .map((id) => id.trim())
    .filter(Boolean);
  if (values.help) {
    return { help: true };
  }
  const changedMode = Boolean(values.staged) || values['changed-since'] !== undefined;
  // A hook should stop on any new finding it reports, not only on declared contracts.
  const failOn = values['fail-on'] ?? (changedMode ? 'all' : 'contract');
  if (positionals.length > 1 || !['all', 'contract'].includes(failOn)) {
    throw new Error('Pass one directory and --fail-on contract or all.');
  }
  const minImpact = parseMinImpact(values['min-impact']);
  const format = resolveFormat(values);
  if (['sarif', 'github'].includes(format) && values.fix)
    throw new Error('--format sarif and github cannot be combined with --fix.');
  if (values.only.length && !values.fix) throw new Error('--only is only valid with --fix.');
  if (values.only.length && !onlyIds.length) throw new Error('--only needs at least one finding id.');
  if (values.fix && (values.graph !== undefined || (format === 'json' && !onlyIds.length)))
    throw new Error('--fix cannot be combined with --graph, or with --json unless --only is given.');
  if (values.yes && !values.fix) throw new Error('--yes is only valid with --fix.');
  if ((values.comments || values['no-comments'] || values['no-format']) && !values.fix)
    throw new Error('--comments, --no-comments and --no-format are only valid with --fix.');
  if ((baselineOptions.baseline || baselineOptions.writeBaseline) && values.fix) {
    throw new Error('--baseline and --write-baseline cannot be combined with --fix.');
  }
  if (baselineOptions.writeBaseline && changedMode) {
    throw new Error('--write-baseline records every finding; it cannot be combined with --staged or --changed-since.');
  }
  return { values, directory: positionals[0], format, minImpact, failOn, baselineOptions, onlyIds };
}

async function reportEmptyChanges(root: string, format: OutputFormat, onlyIds: string[]): Promise<number> {
  if (onlyIds.length) {
    const { applyChosenFixes } = await import('./fix-cli.js');
    return applyChosenFixes([], onlyIds, root, {
      json: format === 'json',
    });
  }
  const report = { mode: 'source', scannedFiles: 0, findings: [], contractFindingCount: 0 };
  if (format === 'json') console.log(JSON.stringify(report));
  if (format === 'sarif') console.log(renderReports(format, [{ pillar: 'maintainability', root, report }]));
  return 0;
}

async function scanProject(
  root: string,
  values: ScanValues,
  { changes, inScope }: { changes: ChangedRanges | undefined; inScope: InScope | undefined },
): Promise<ScanProjectResult> {
  enableCompileCache?.();
  const { loadPolicy, checkImportedGraph } = await import('./project.js');
  const settings = loadSettings({ directory: root, explicit: values['loadwise-config'], ignore: values.ignore });
  const policy = loadPolicy(values.config, settings.maintainability);
  // Ignored files leave file discovery, so duplicates, cycles and boundaries never see them.
  const { isIgnored } = settings;
  if (isIgnored) policy.isIgnored = (file) => isIgnored(root, file);
  const scanResult: SourceScan | GraphScan = changes
    ? await (await import('./scan-changed.js')).scanChangedFiles(root, policy, [...changes.keys()], { inScope })
    : values.graph !== undefined
      ? checkImportedGraph(values.graph, policy)
      : await (
          await import('./scan.js')
        ).scan(root, policy, {
          inScope,
          indexIdentifiers: true,
        });
  const { report, ignoredAllSources, identifierIndex } = withoutSourceDetails(scanResult);
  if (ignoredAllSources && !changes) {
    console.error(`Note: every source file matches "ignore" in ${settings.filename}; no files were left to check.`);
  }
  if (inScope)
    report.findings = report.findings.filter((finding) => finding.file !== undefined && inScope(finding.file));
  report.findings.sort(
    (left, right) =>
      (left.file ?? '').localeCompare(right.file ?? '') ||
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.column ?? 0) - (right.column ?? 0) ||
      left.ruleId.localeCompare(right.ruleId),
  );
  if (report.mode === 'source') {
    const { applyReviewDirectives } = await import('./review-directive.js');
    applyReviewDirectives(report.findings, root);
  }
  assignFindingIds(report.findings, root);
  // Ids are assigned first, so collision suffixes do not depend on which findings the config drops.
  report.findings = settings.apply(report.findings, root);
  if (changes) report.findings = filterToChangedLines(report.findings, changes);
  return { report, policy, settings, identifierIndex };
}

function filterAdvisories(
  report: MaintainabilityReport,
  minImpact: ImpactLevel | undefined,
  includeContextual: boolean | undefined,
): void {
  report.findings = sortByImpactWithinFiles(filterMinImpact(annotateImpact(report.findings, impactByRule), minImpact));
  const contracts = contractRules.maintainability;
  const contextual = report.findings.filter(
    (finding: Finding) => finding.contextualReason && !contracts.has(finding.ruleId),
  );
  if (contextual.length) {
    report.contextualFindingCount = contextual.length;
    if (!includeContextual)
      report.findings = report.findings.filter(
        (finding: Finding) => !finding.contextualReason || contracts.has(finding.ruleId),
      );
  }
}

async function processBaseline(
  report: MaintainabilityReport,
  {
    baselineOptions,
    root,
    values,
    format,
  }: { baselineOptions: BaselineFlagOptions; root: string; values: ScanValues; format: OutputFormat },
): Promise<BaselineWritten | BaselineFiltered | undefined> {
  const { applyBaselineOptions, baselineForScan } = await import('../shared/baseline.js');
  const baseline = applyBaselineOptions({
    // A --graph scan covers the graph, not the folder, so only a folder scan limits the baseline to
    // it.
    options: baselineForScan(baselineOptions, values, values.graph === undefined ? [root] : []),
    pillar: 'maintainability',
    findings: report.findings,
    projectRoot: root,
    absoluteFileOf: (finding: Finding) => path.resolve(root, finding.file ?? ''),
    idRoot: root,
  });
  if (baseline && 'written' in baseline) {
    const message = `Wrote ${baseline.written} finding(s) to ${path.relative(process.cwd(), baseline.file) || baseline.file}.`;
    (format === 'text' ? console.log : console.error)(message);
    return baseline;
  }
  if (baseline) {
    report.findings = baseline.findings;
    report.baselineHidden = baseline.hidden;
    report.baselineStale = baseline.stale;
  }
  report.contractFindingCount = report.findings.filter((finding: Finding) =>
    contractRules.maintainability.has(finding.ruleId),
  ).length;
  return baseline;
}

// The scan's own details, such as the identifier index, are for the fixes and stay out of the
// printed report.
function withoutSourceDetails(result: SourceScan | GraphScan): {
  report: MaintainabilityReport;
  ignoredAllSources?: boolean;
  identifierIndex?: Map<string, string>;
} {
  if (result.mode === 'graph') return { report: result };
  const { ignoredAllSources, identifierIndex, ...report } = result;
  return { report, ignoredAllSources, identifierIndex };
}

function relatedSites(finding: Finding): readonly SourceLocation[] {
  return Array.isArray(finding.related) ? finding.related : [];
}

function printStructuredReport(report: MaintainabilityReport, format: OutputFormat, root: string): void {
  for (const finding of report.findings) {
    addExample(finding);
    finding.fixable = Boolean(finding.fix);
  }
  if (format === 'json') console.log(JSON.stringify(report, null, 2));
  else {
    const output = renderReports(format, [{ pillar: 'maintainability', root, report }]);
    if (output) console.log(output);
  }
}

function printFinding(finding: Finding, printedRules: Set<string>, fixCommand: string): void {
  console.log(
    `${finding.file}:${finding.line}:${finding.column} [${finding.ruleId} #${finding.id}] ${finding.impactLevel}: ${finding.message}`,
  );
  if (finding.contextualReason) console.log('  ' + finding.contextualReason);
  for (const site of relatedSites(finding)) console.log(`  ${site.file}:${site.line}:${site.column}`);
  if (finding.fix) for (const line of fixLines(finding.fix)) console.log(line);
  else printFixOnce(finding.ruleId, printedRules);
  if (finding.fix?.requiresReview) {
    console.log(`  After individual review: ${fixCommand} --fix --only ${finding.id}`);
  }
}

// The shared reason once, then each location with its own details one level further in.
function printFindingGroup(group: Finding[], printedRules: Set<string>, fixCommand: string): void {
  const [first] = group;
  const context = first.contextualReason ? ` (${first.contextualReason})` : '';
  console.log(`[${first.ruleId}] ${first.impactLevel}: ${first.message}${context} (${group.length} findings)`);
  for (const finding of group) {
    console.log(`  ${finding.file}:${finding.line}:${finding.column} #${finding.id}`);
    for (const site of relatedSites(finding)) console.log(`    ${site.file}:${site.line}:${site.column}`);
    if (finding.fix) for (const line of fixLines(finding.fix)) console.log('  ' + line);
    if (finding.fix?.requiresReview) {
      console.log(`    After individual review: ${fixCommand} --fix --only ${finding.id}`);
    }
  }
  if (group.some((finding: Finding) => !finding.fix)) printFixOnce(first.ruleId, printedRules);
}

async function printTextReport(
  report: MaintainabilityReport,
  { directory, values, baseline, settings, policy }: TextReportContext,
): Promise<void> {
  const printedRules = new Set<string>();
  const fixCommand = fixAllCommand(directory, values);
  for (const group of groupByReason(report.findings, findingReason)) {
    if (group.length === 1) printFinding(group[0], printedRules, fixCommand);
    else printFindingGroup(group, printedRules, fixCommand);
  }
  console.log(
    `${report.mode === 'source' ? report.scannedFiles : report.graphFiles} ${report.mode} file(s), ${report.findings.length} finding(s), ${report.contractFindingCount} contract finding(s).`,
  );
  if (report.contextualFindingCount && !values['include-contextual'])
    console.log(`${report.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
  const warningNote = settings.warningNote(report.findings);
  if (warningNote) console.log(warningNote);
  if (baseline) {
    const { baselineNoteLines } = await import('../shared/baseline.js');
    for (const line of baselineNoteLines(baseline)) console.log(line);
  }
  if (report.mode === 'source' && policy.boundaries.length && report.dependencyFiles < report.scannedFiles) {
    console.log(
      `Source dependency analysis covered ${report.dependencyFiles} JS/TS files. Use --graph for additional language boundaries.`,
    );
  }
  const fixableIds = report.findings
    .filter((finding: Finding) => finding.fix && !finding.fix.requiresReview)
    .map((finding: Finding) => finding.id);
  if (report.mode === 'source' && fixableIds.length) {
    console.log(`Fix all: ${fixCommand} --fix --only ${fixableIds.join(',')}`);
  }
}

async function printScanReport(report: MaintainabilityReport, options: PrintContext): Promise<void> {
  const { root, format, directory, values, baseline, changes } = options;
  if (format !== 'text') printStructuredReport(report, format, root);
  else if (changes) {
    const { printChangedFindings } = await import('./changed-output.js');
    printChangedFindings(report.findings, fixAllCommand(directory, values));
    if (baseline) {
      const { baselineNoteLines } = await import('../shared/baseline.js');
      for (const line of baselineNoteLines(baseline)) console.log(line);
    }
  } else await printTextReport(report, options);
}

async function main(args: string[]): Promise<number> {
  if (args[0] === 'agent') return (await import('../shared/agent-init.js')).runAgentCommand(args.slice(1));
  const parsed = parseScanOptions(args);
  if (parsed.help) {
    console.log(help);
    return 0;
  }
  const { values, directory, format, minImpact, failOn, baselineOptions, onlyIds } = parsed;
  const root = path.resolve(directory ?? '.');
  if (!(await fs.promises.stat(root).catch(() => undefined))?.isDirectory())
    throw new Error('Expected a project directory.');
  const workspaceFolders = await selectedWorkspaceFolders(root, values.workspace);
  const inScope: InScope | undefined =
    workspaceFolders && ((file: string) => workspaceFolders.some((folder) => file.startsWith(folder + '/')));
  const changes = readChanges(root, values);
  if (changes && !changes.size) return await reportEmptyChanges(root, format, onlyIds);
  const { report, policy, settings, identifierIndex } = await scanProject(root, values, { changes, inScope });
  // Named ids are explicit, so they reach contextual findings too.
  if (onlyIds.length) {
    const [{ attachSiteFixes }, { applyChosenFixes }, { fixPresentation }] = await Promise.all([
      import('./site-fix.js'),
      import('./fix-cli.js'),
      import('../shared/fix-presentation.js'),
    ]);
    attachSiteFixes(
      report.findings.filter((finding) => finding.id !== undefined && onlyIds.includes(finding.id)),
      root,
      { identifierIndex },
    );
    return exitCodeWithSkips(
      report,
      await applyChosenFixes(report.findings, onlyIds, root, {
        json: format === 'json',
        ...fixPresentation(values),
      }),
    );
  }
  filterAdvisories(report, minImpact, values['include-contextual']);
  const baseline = await processBaseline(report, { baselineOptions, root, values, format });
  if (baseline && 'written' in baseline) return exitCodeWithSkips(report, 0);
  if (report.mode === 'source') {
    const { attachSiteFixes } = await import('./site-fix.js');
    attachSiteFixes(report.findings, root, {
      identifierIndex,
    });
  }
  if (values.fix) {
    const [{ applyFixes }, { fixPresentation }] = await Promise.all([
      import('./fix-cli.js'),
      import('../shared/fix-presentation.js'),
    ]);
    const fixCode = await applyFixes(report.findings, root, {
      all: values.yes,
      ...fixPresentation(values),
    });
    return exitCodeWithSkips(report, fixCode);
  }
  await printScanReport(report, { root, format, directory, values, baseline, settings, policy, changes });
  if (report.mode === 'source' && !changes) notifyEditor(root);
  const isContract =
    failOn === 'all' ? undefined : (finding: Finding) => contractRules.maintainability.has(finding.ruleId);
  return exitCodeWithSkips(report, settings.exitCount(report.findings, isContract) ? 1 : 0);
}

export { main };
