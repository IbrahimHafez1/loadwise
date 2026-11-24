import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { impactByRule } from './rule-ids.cjs';
import { sourceCheckOptions, validateSourceOptions } from './source-options.cjs';
import { annotateImpact, filterMinImpact, parseMinImpact, sortByImpactWithinFiles } from '../shared/impact-levels.cjs';
import { loadSettings, loadConfig } from '../shared/config.cjs';
import { applyBaselineOptions, baselineForScan, baselineNoteLines, extractBaselineFlags } from '../shared/baseline.cjs';
import { resolveFormat, renderReports } from '../shared/formats/index.cjs';
import { contractRules } from '../shared/formats/contract-rules.cjs';
import { fixPresentation } from '../shared/fix-presentation.cjs';
import { editorAnalyzers, exitCodeWithSkips, noteEmptyIgnoredScan, reportSourceResult } from './scan-outcome.cjs';
import type { Finding } from '../shared/types.cjs';
import type { PolyglotScan } from './polyglot.cjs';
import type { BaselineFiltered, BaselineFlagOptions, BaselineRunOptions } from '../shared/types/baseline.cjs';
import type { SourceReportPillar, SourceReportResult, SourceReportValues } from '../shared/types/source-report.cjs';
import type { scanDependencies } from '../security/deps/scan.cjs';
import type { PerformancePolicy } from './types/performance-policy.cjs';
import type { SourceAnalyzer } from './types/source-analyzer.cjs';
import type { SourceCheckValues } from './types/source-check-values.cjs';
import type { ChangedScope, ScanSettings, SourceScanValues } from './types/source-scan-values.cjs';
import { formatImpact } from './impact.cjs';
import { resolveConfig } from './source-inputs.cjs';
import { validateQueryPolicy, loadQueryPolicy } from './query-policy.cjs';
import { discoverWorkspaces, projectConfig, selectWorkspaces, plainJavaScriptSources } from '../shared/workspaces.cjs';
import { enableCompileCache } from 'node:module';
import { notifyEditor } from './notify-editor.cjs';
import { sourceHistoryProject } from '../shared/fix-history.cjs';
import { applyChosenFixes, applyFixes } from './fix-cli.cjs';
import { findProjectRoot, loadSnapshot, useSnapshot } from './schema/context.cjs';
import { assignFindingIds as assignFindingIdsFindingIds } from './finding-ids.cjs';
import * as sourceReport from '../shared/source-report.cjs';
import * as security from '../security/cli.cjs';
import { scanDependencies as scanDependenciesScan } from '../security/deps/scan.cjs';
import { noteOffline } from '../security/deps/cli.cjs';
import { projectDialect } from './schema/project-indexes.cjs';
import { checkSchemaFile, findPrismaSchemaFiles } from './schema/prisma-schema.cjs';
import { keepChangedFindings, collectProjectChangedLines, fileKey } from './changed-lines.cjs';
import { attachExample } from './finding-text.cjs';
import { printChangedFindings, printFullReport } from './source-text.cjs';
import { runAgentCommand } from '../shared/agent-init.cjs';
import type * as Projects from './projects.cjs';
import type * as Typescript from 'typescript';
import type * as RedundantIndexes from './redundant-indexes.cjs';
import type * as Native from './native.cjs';
import type * as ReviewContext from './review-context.cjs';
import type * as SiteFix from './site-fix.cjs';
import type * as EditorSetup from './editor-setup.cjs';

type PrintLine = (line: string) => void;

/**
 * A workspace package as the report names it: its name and its folder relative to the working
 * directory.
 */
interface WorkspacePackageSummary {
  name: string;
  directory: string;
}

/** The packages of a monorepo scan, with the config each is checked with. */
interface WorkspaceTarget {
  directory: string;
  configs: string[];
  packages: WorkspacePackageSummary[];
}

/** Where a scan reads its policy from, and how to read it again in watch mode. */
interface PolicySource {
  filename: string;
  read(): PerformancePolicy | undefined;
}

/**
 * What a perf scan produces before it is printed: the shared report fields, the engine and the
 * dependency count.
 */
interface PerformanceScanResult extends SourceReportResult {
  engine?: string;
  scannedPackages?: number;
}

/** The parsed flags once the scan has added its settings and the folder that names the project. */
interface ScanValues extends SourceScanValues {
  projectDirectory: string;
}

/**
 * The members of the parsed flags that printing reads; `loadwise perf polyglot` supplies only some
 * of them.
 */
interface PrintValues extends Omit<SourceReportValues, 'projectDirectory' | 'settings'> {
  settings: ScanSettings;
  projectDirectory?: string;
}

interface SourceCodeOptions {
  project?: string | string[];
  files: string[];
  policy?: PerformancePolicy;
  onlyFiles?: (filename: string) => boolean;
  analyzers?: SourceAnalyzer[];
}

interface AnalyzedSource {
  result: PerformanceScanResult;
  usedFallback: boolean;
}

type FindingsReporter = (result: PerformanceScanResult, values: PrintValues) => Finding[];
type ExitCodeReporter = (result: PerformanceScanResult, values: PrintValues) => number;

interface PillarOutput {
  code: number;
  stdout: string;
}

interface CheckWithSecurityInput {
  values: ScanValues;
  positionals: string[];
  policy: PerformancePolicy | undefined;
  scope: ChangedScope | undefined;
  workspace: WorkspaceTarget | undefined;
  project: string | undefined;
  baselineOptions: BaselineRunOptions;
  inferredFiles: string[] | undefined;
}

interface ScanSourceInput {
  values: ScanValues;
  positionals: string[];
  workspace: WorkspaceTarget | undefined;
  inferredFiles: string[] | undefined;
  policy: PerformancePolicy | undefined;
  scope: ChangedScope | undefined;
  engine: string;
  report: ExitCodeReporter | FindingsReporter;
}

const usage = `Usage:
  loadwise perf [-p tsconfig.json | -p monorepo-root [--workspace name|path ...] | file.ts file.js ...] [--engine auto|native|js] [--policy policy.json] [--loadwise-config loadwise.config.json] [--schema snapshot.json] [--json | --format text|json|sarif|github] [--include-contextual] [--ignore rule-id] [--min-impact low|medium|high|critical] [--fail-on all|contract] [--baseline [file] | --write-baseline [file]] [--fix [--yes | --only id,...] [--no-comments] [--no-format]]
  loadwise perf [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]
  loadwise perf --watch [-p tsconfig.json] [--policy policy.json] [--schema snapshot.json] [--include-contextual] [--ignore rule-id]
  loadwise perf contracts [--changed-since git-ref] [--json]
  loadwise perf migrations [paths...] [--changed-since git-ref] [--baseline file] [--write-baseline] [--dialect postgres|mysql] [--json] [--include-contextual] [--ignore rule-id]
  loadwise perf db [--url-env DATABASE_URL] [--env-file .env] [--engine postgres|mysql|mongo] [--schema-snapshot out.json] [--top 20] [--queries file.sql] [--analyze] [--measure --i-understand-this-locks-tables] [--runs 5] [--json] [--ignore rule-id]
  loadwise perf traces trace.json [--threshold 5] [--json]
  loadwise perf plan explain.json [--json]
  loadwise perf polyglot <file-or-directory> ... [--json]
  loadwise perf editor init
  loadwise perf editor watch [-p tsconfig.json]
  loadwise perf agent init [--mode ask|auto] [--hook [block|warn|off]]

With no arguments, check tsconfig.json or jsconfig.json in the current directory.
In a monorepo root without one, every workspace package (package.json "workspaces", pnpm-workspace.yaml or lerna.json) with its own tsconfig.json or jsconfig.json is checked in one report; --workspace limits it to the named packages or folders.
Source checks look for backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
A loadwise.config.json there also applies: its "performance" section replaces backend-perf.policy.json, and its ignore, rules and overrides filter the findings; --loadwise-config names another file.
--fix shows each available code fix and asks before applying it; --fix --yes applies eligible fixes without asking.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
--fix adds a "// Loadwise <rule-id>: <why>" comment above each fixed statement and formats the changed lines with the project's Prettier; --no-comments and --no-format turn these off.
Every finding has a stable id (shown as #id); a failed --only id exits 2.
--write-baseline records the current findings in loadwise-baseline.json (or the given file); --baseline hides them so only new findings are reported and reports how many were hidden.
The baseline file has one section per checker, shared with loadwise maint and loadwise check; entries are matched by rule, file and flagged code, not line number.
--staged and --changed-since report only findings on lines changed in the git index or since a ref, with a fix and a dismiss command per finding.
agent init writes one block of instructions for AI coding agents, covering all three checkers, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
Source checks summarize contextual findings. --include-contextual includes their locations and review reasons.
Source checks use the TypeScript 7 native compiler when it is installed and accepts the project, otherwise TypeScript 6.
--engine native requires TypeScript 7 (--native is an alias). --engine js always uses TypeScript 6.
--fail-on contract exits 1 only for pg-transaction-on-pool.
--min-impact reports only findings at that impact level or above; the rest do not count toward the exit code.
--format sarif and github print the findings for GitHub code scanning and workflow annotations; --json is --format json.
--schema reads a snapshot written by db --schema-snapshot; it refines index checks with table sizes and measured round trips.
Only the db command connects to a database. Every other command works from files alone.
The traces command reads one OTLP/JSON export. Its threshold counts sibling DB spans.
Exit codes: 0 passed, 1 findings meeting the exit threshold, 2 invalid input or configuration.`;

function readJsonFile(filename: string, label: string): unknown {
  const raw = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(label + ' file contains invalid JSON.');
  }
}

function parseCommand<Options extends NonNullable<ParseArgsConfig['options']>>(
  args: readonly string[],
  options: Options,
) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, ...options },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function showHelp(): number {
  console.log(usage);
  return 0;
}

async function checkPlan(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseCommand(args, { json: { type: 'boolean' } });
  if (values.help) return showHelp();
  if (positionals.length !== 1) throw new Error('Pass exactly one executed query plan to plan.');
  const result = (await import('./plans.cjs')).inspectPlan(readJsonFile(positionals[0], 'Plan'));
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const { path, ruleId, message, ...metrics } of result.findings) {
      console.log(`${path} [${ruleId}] ${message} ${JSON.stringify(metrics)}`);
    }
    console.log(`${result.engine} execution plan, ${result.findings.length} finding(s).`);
  }
  return result.findings.length ? 1 : 0;
}

async function checkTraces(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    json: { type: 'boolean' },
    threshold: { type: 'string', default: '5' },
  });
  if (values.help) return showHelp();
  if (positionals.length !== 1) throw new Error('Pass exactly one OTLP JSON file to traces.');
  const threshold = Number(values.threshold);
  if (!/^\d+$/.test(values.threshold) || !Number.isSafeInteger(threshold) || threshold < 2) {
    throw new Error('--threshold must be an integer of at least 2.');
  }
  const document = readJsonFile(positionals[0], 'Trace');
  const result = (await import('./traces.cjs')).inspectTraces(document, { threshold });
  const { findings, scannedSpans, eligibleDbSpans } = result;
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const finding of findings) {
      console.log(
        `${finding.traceId} parent ${finding.parentSpanId || '(root)'} [${finding.ruleId}] ${finding.message}`,
      );
      const impact = formatImpact(finding.impact);
      if (impact) console.log(`  ${impact}`);
    }
    console.log(
      `${eligibleDbSpans} distinct eligible DB span(s) across ${scannedSpans} input span(s), ${findings.length} finding(s).`,
    );
  }
  return findings.length ? 1 : 0;
}

// The folder holding backend-perf.policy.json and loadwise.config.json: the project, or the working
// directory for files.
function projectDirectory(config: string | undefined, files: readonly string[]): string {
  return files.length ? process.cwd() : path.dirname(resolveConfig(config ?? '.'));
}

// The "performance" section of loadwise.config.json holds the same policy as
// backend-perf.policy.json.
function configPolicySource(filename: string): PolicySource {
  return {
    filename,
    read() {
      try {
        return validateQueryPolicy(loadConfig({ directory: process.cwd(), explicit: filename })?.config.performance);
      } catch (error) {
        throw new Error('Cannot load the "performance" section of ' + filename + ': ' + errorMessage(error));
      }
    },
  };
}

function sourcePolicy(explicit: string | undefined, directory: string, settings: ScanSettings): PolicySource {
  const filename = explicit !== undefined ? path.resolve(explicit) : path.join(directory, 'backend-perf.policy.json');
  if (explicit === undefined && settings.performance && settings.filename !== undefined) {
    if (fs.existsSync(filename)) {
      console.error(`Note: ${settings.filename} has a "performance" section; ignoring ${filename}.`);
    }
    return configPolicySource(settings.filename);
  }
  let required = explicit !== undefined;
  return {
    filename,
    read() {
      try {
        const policy = loadQueryPolicy(filename);
        required = true;
        return policy;
      } catch (error) {
        if (errorCode(error) === 'ENOENT' && !required) return;
        // Once discovered, a broken or removed policy must not silently disable enforcement in
        // watch mode.
        required = true;
        throw new Error('Cannot load query policy ' + filename + ': ' + errorMessage(error));
      }
    },
  };
}

// A directory without its own config, or an explicit --workspace, means a monorepo: one config per
// package.
function workspaceTarget(
  values: Pick<SourceCheckValues, 'project' | 'workspace'>,
  positionals: readonly string[],
): WorkspaceTarget | undefined {
  const directory = path.resolve(values.project ?? '.');
  const isDirectory = fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory();
  if (positionals.length || !isDirectory) {
    if (values.workspace.length) throw new Error('--workspace needs a monorepo directory.');
    return undefined;
  }
  if (!values.workspace.length && projectConfig(directory)) return undefined;
  const { packages, withoutConfig } = discoverWorkspaces(directory);
  if (!packages.length) {
    if (values.workspace.length)
      throw new Error('--workspace found no workspace package with a tsconfig.json or jsconfig.json.');
    return undefined;
  }
  for (const { name } of withoutConfig) {
    console.error(`Note: workspace ${name} has no tsconfig.json or jsconfig.json; skipped it.`);
  }
  const chosen = selectWorkspaces(packages, directory, values.workspace);
  return {
    directory,
    configs: chosen.map(({ config }) => config),
    packages: chosen.map(({ name, directory: packageDirectory }) => ({
      name,
      directory: relativeToCwd(packageDirectory),
    })),
  };
}

function relativeToCwd(target: string): string {
  return path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
}

function checkCode(args: readonly string[], report: FindingsReporter): Promise<Finding[]>;
function checkCode(
  args: readonly string[],
  report?: ExitCodeReporter,
  baselineFlags?: BaselineFlagOptions,
): Promise<number>;
async function checkCode(
  args: readonly string[],
  report: ExitCodeReporter | FindingsReporter = printResult,
  baselineFlags: BaselineFlagOptions = {},
): Promise<number | Finding[]> {
  const { values: parsedValues, positionals } = parseCommand(args, sourceCheckOptions);
  if (parsedValues.help) return showHelp();
  const baselineOptions = baselineForScan(
    baselineFlags,
    parsedValues,
    positionals.map((file) => path.resolve(file)),
  );
  const { engine, onlyIds } = validateSourceOptions(parsedValues, positionals, baselineOptions);
  const scope = readChangedScope(parsedValues, positionals);
  if (scope && !scope.changedLines.size && !parsedValues.online) {
    printEmptyChangedReport(parsedValues);
    return 0;
  }
  await loadSqlParser();
  loadSchemaSnapshot(parsedValues.schema);
  const workspace = workspaceTarget(parsedValues, positionals);
  if (workspace && parsedValues.watch) throw new Error('--watch needs one project config, not a monorepo.');
  // The folder that names the project in ids, the policy lookup and the printed fix command.
  const project = workspace ? relativeToCwd(workspace.directory) : parsedValues.project;
  // Node reuses bytecode for the compiler across invocations. Each run still reads the current
  // project.
  enableCompileCache?.();
  const { directory, inferredFiles } = resolveScanInputs(parsedValues, positionals, workspace);
  const values: ScanValues = {
    ...parsedValues,
    // CLI --ignore ids are filtered by selectFindings, so the settings only add the config's own
    // filters.
    settings: loadSettings({ directory, explicit: parsedValues['loadwise-config'] }),
    // The default baseline file sits in the same folder.
    projectDirectory: directory,
  };
  const policySource = sourcePolicy(values.policy, directory, values.settings);
  const policy = policySource.read();
  if (values.with !== undefined)
    return checkWithSecurity({
      values,
      positionals,
      policy,
      scope,
      workspace,
      project,
      baselineOptions,
      inferredFiles,
    });
  if (values.watch) return watchSource(values, policySource);
  const scanned = scanSource({ values, positionals, workspace, inferredFiles, policy, scope, engine, report });
  const { result } = scanned;
  if (workspace && workspace.packages.length > 1) result.packages = workspace.packages;
  noteEmptyIgnoredScan(result, values, scope);
  if (!positionals.length) appendPrismaSchemaFindings(result, workspace?.configs ?? [project ?? '.'], scope);
  if (values.fix && report === printResult) {
    return exitCodeWithSkips(result, await applySourceFixes(result, values, onlyIds, project, positionals));
  }
  const code = reportSourceResult({ ...scanned, values, project, baselineOptions, positionals, scope, report });
  if (report === printResult) notifyEditor(values.project ?? process.cwd());
  return code;
}

function resolveScanInputs(
  values: Pick<SourceCheckValues, 'project' | 'watch'>,
  positionals: readonly string[],
  workspace: WorkspaceTarget | undefined,
): { directory: string; inferredFiles: string[] | undefined } {
  // A monorepo root keeps its policy and config at the root, beside no project config.
  const input = path.resolve(values.project ?? '.');
  const inferredFiles = !workspace && !positionals.length && !values.watch ? plainJavaScriptSources(input) : undefined;
  const directory = workspace?.directory ?? (inferredFiles ? input : projectDirectory(values.project, positionals));
  return { directory, inferredFiles };
}

async function watchSource(values: ScanValues, policySource: PolicySource): Promise<number> {
  const { watchProject } = await import('./watch.cjs');
  watchProject(values.project ?? '.', {
    policySource,
    onResult(result) {
      appendPrismaSchemaFindings(result, [values.project ?? '.']);
      printResult(result, values);
    },
    onError(error) {
      console.error(typeof error === 'object' && error !== null && 'message' in error ? error.message : error);
    },
  });
  return 0;
}

function scanSource({
  values,
  positionals,
  workspace,
  inferredFiles,
  policy,
  scope,
  engine,
  report,
}: ScanSourceInput): AnalyzedSource {
  // The editor watcher checks repeatedly in one process, which keeps it on the JS compiler. It
  // shows the security findings too, from the same Program.
  const analyzers = report !== printResult && editorAnalyzers();
  return analyzeSourceCode(
    {
      project: workspace?.configs ?? values.project,
      files: inferredFiles ?? positionals,
      policy,
      onlyFiles: scanFilter(values.settings, scope),
      ...(analyzers && { analyzers }),
    },
    report === printResult ? engine : 'js',
  );
}

function applySourceFixes(
  result: PerformanceScanResult,
  values: ScanValues,
  onlyIds: readonly string[],
  project: string | undefined,
  files: readonly string[],
): number | Promise<number> {
  assignFindingIds(result.findings, findingRoot(project));
  const historyProject = sourceHistoryProject(values.projectDirectory, files);
  // Named ids are explicit, so they reach contextual and ignored findings too.
  if (onlyIds.length) {
    return applyChosenFixes(result.findings, onlyIds, {
      json: resolveFormat(values) === 'json',
      project: historyProject,
      ...fixPresentation(values),
    });
  }
  // --fix offers exactly the findings the report would show, so --min-impact narrows it too.
  selectFindings(result, values);
  result.findings = filterMinImpact(annotateImpact(result.findings, impactByRule), values['min-impact']);
  return applyFixes(result.findings, {
    all: values.yes,
    project: historyProject,
    ...fixPresentation(values),
  });
}

// Ids hash paths relative to the project root, so they match whichever folder the check runs from.
function findingRoot(project: string | undefined): string {
  return findProjectRoot(path.resolve(project ?? '.'));
}

function assignFindingIds(findings: Finding[], root: string): void {
  assignFindingIdsFindingIds(findings, root);
}

// `check` runs perf and sec together through `--with sec`, so the project is type-checked once on
// the JS compiler. Prints { performance: { code, stdout }, security: { code, stdout } } for the
// parent to split.
async function checkWithSecurity({
  values,
  positionals,
  policy,
  scope,
  workspace,
  project,
  baselineOptions,
  inferredFiles,
}: CheckWithSecurityInput): Promise<number> {
  const { analyzeSources, performanceAnalyzers }: typeof Projects = require('./projects.cjs');
  const performancePillar: SourceReportPillar = { command: 'perf', contractRules: contractRules.performance };
  const result: PerformanceScanResult = analyzeSources({
    project: workspace?.configs ?? values.project,
    files: inferredFiles ?? positionals,
    policy,
    onlyFiles: scanFilter(values.settings, scope),
    analyzers: [...performanceAnalyzers, security.analyzer],
  });
  if (!positionals.length) appendPrismaSchemaFindings(result, workspace?.configs ?? [project ?? '.'], scope);
  if (workspace) result.packages = workspace.packages;
  const fileFindings = security.scanFiles(values, positionals, workspace, scope?.isChangedFile).findings;
  let dependencies: Awaited<ReturnType<typeof scanDependencies>> | undefined;
  let dependencyError: unknown;
  if (values.online) {
    try {
      dependencies = await scanDependenciesScan(values.projectDirectory);
    } catch (error) {
      dependencyError = error;
    }
  } else if (!scope) {
    noteOffline(values.projectDirectory);
  }
  function reportPillar(jsonKey: 'performance' | 'security', pillar: SourceReportPillar): PillarOutput {
    const isSecurity = jsonKey === 'security';
    if (isSecurity && dependencyError) {
      console.error(errorMessage(dependencyError));
      return { code: 2, stdout: '' };
    }
    const findings = result.findings.filter((finding) => (finding.pillar ?? 'performance') === jsonKey);
    for (const finding of findings) delete finding.pillar;
    if (isSecurity) findings.push(...fileFindings, ...(dependencies?.findings ?? []));
    const reportResult: PerformanceScanResult = { ...result, findings };
    if (isSecurity && dependencies) {
      reportResult.scannedFiles += dependencies.scannedFiles;
      reportResult.scannedPackages = dependencies.scannedPackages;
    }
    const pillarValues: ScanValues = {
      ...values,
      project,
      baselineOptions,
      fixCommand: sourceReport.fixAllCommand(pillar.command, project, positionals, values),
      ...(scope && { changedLines: scope.changedLines }),
    };
    const lines: string[] = [];
    const print = (line: string): void => {
      lines.push(line);
    };
    const code = exitCodeWithSkips(
      reportResult,
      jsonKey === 'performance'
        ? printResult(reportResult, pillarValues, print)
        : sourceReport.printResult(reportResult, pillarValues, pillar, print),
    );
    return { code, stdout: lines.map((line) => line + '\n').join('') };
  }
  const reports = {
    performance: reportPillar('performance', performancePillar),
    security: reportPillar('security', security.pillar),
  };
  console.log(JSON.stringify(reports));
  notifyEditor(values.project ?? process.cwd());
  return Math.max(reports.performance.code, reports.security.code);
}

// schema.prisma is not TypeScript, so its foreign-key findings come from the parsed schema after
// the scan.
function appendPrismaSchemaFindings(
  result: Pick<PerformanceScanResult, 'findings'>,
  projects: readonly string[],
  scope?: ChangedScope,
): void {
  const { checkRedundantSchemaIndexes }: typeof RedundantIndexes = require('./redundant-indexes.cjs');
  const roots = new Set(projects.map((project) => findProjectRoot(path.resolve(project))));
  // Migrations and schema files sit outside the TypeScript program, so their redundant indexes are
  // found here.
  for (const root of roots) {
    const options = { isChangedFile: scope?.isChangedFile, dialect: projectDialect(root) };
    result.findings.push(...checkRedundantSchemaIndexes(root, options));
  }
  if (scope && ![...scope.changedLines.keys()].some((file) => file.endsWith('.prisma'))) return;
  for (const root of roots) {
    if (!scope || findPrismaSchemaFiles(root).some(scope.isChangedFile)) result.findings.push(...checkSchemaFile(root));
  }
}

// The snapshot is optional; without it every rule still reports, using unknown-size wording.
function loadSchemaSnapshot(filename: string | undefined): void {
  useSnapshot(filename === undefined ? undefined : loadSnapshot(path.resolve(filename)));
}

// Only the first sentence: the full TypeScript 7 diagnostic list repeats itself and buries the
// findings.
function firstReason(reason: string): string {
  return reason.split(/(?<=\.)\s+/)[0].replace(/\.$/, '');
}

// Loading the JS engine binds the shared rules to TypeScript 6, so it is required only once native
// is ruled out.
function analyzeSourceCode(options: SourceCodeOptions, engine: string): AnalyzedSource {
  const analyzeSources = (sourceOptions: SourceCodeOptions) => {
    const projects: typeof Projects = require('./projects.cjs');
    return projects.analyzeSources(sourceOptions);
  };
  if (engine === 'js') return { result: { ...analyzeSources(options), engine }, usedFallback: false };
  const native: typeof Native = require('./native.cjs');
  const result = native.analyzeNative({
    ...options,
    fallback: engine === 'auto',
  });
  if (!result.fallback) return { result: { ...result, engine: 'native' }, usedFallback: false };
  const fallbackResult = analyzeSources(options);
  if (result.reason) {
    const { version }: typeof Typescript = require('typescript');
    console.error(
      `Note: TypeScript 7 cannot load this project (${firstReason(result.reason)}); used TypeScript ${version}.`,
    );
  } else {
    console.error('Note: the TypeScript 7 native compiler is not available; used the JS engine.');
  }
  return { result: { ...fallbackResult, engine: 'js' }, usedFallback: true };
}

// Ignored files are never scanned, so they cost no time and add nothing to the file count.
function scanFilter(
  settings: ScanSettings,
  scope: ChangedScope | undefined,
): ((filename: string) => boolean) | undefined {
  const { isIgnored } = settings;
  if (!isIgnored) return scope?.isChangedFile;
  return (filename: string) => !isIgnored(process.cwd(), filename) && (scope?.isChangedFile(filename) ?? true);
}

function selectFindings(
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

function printResult(result: PerformanceScanResult, values: PrintValues, print: PrintLine = console.log): number {
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
function readChangedScope(
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

async function runEditor(args: readonly string[]): Promise<number> {
  if (args[0] === 'init' && args.length === 1) {
    const editorSetup: typeof EditorSetup = require('./editor-setup.cjs');
    const setup = editorSetup.setupEditor(process.cwd());
    console.log((setup.changed ? 'Configured ' : 'Already configured: ') + setup.filename);
    console.log(
      'Open or reopen the trusted folder in VS Code or Cursor and allow automatic tasks once. Terminal source scans refresh the active watcher.',
    );
    return 0;
  }
  if (args[0] !== 'watch') throw new Error('Usage: loadwise perf editor init  |  editor watch [-p tsconfig.json]');
  const { values, positionals } = parseCommand(args.slice(1), { project: { type: 'string', short: 'p' } });
  if (values.help) return showHelp();
  if (positionals.length) throw new Error('editor watch accepts only an optional -p project config.');
  await loadSqlParser();
  (await import('./editor-watch.cjs')).watchEditor(process.cwd(), values.project, (inputs) =>
    checkCode(inputs, selectFindings),
  );
  return 0;
}

async function runPolyglot(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    json: { type: 'boolean' },
    'min-impact': { type: 'string' },
    'loadwise-config': { type: 'string' },
  });
  if (values.help) return showHelp();
  parseMinImpact(values['min-impact']);
  if (!positionals.length) throw new Error('Pass at least one file or directory to polyglot.');
  const result = await (await import('./polyglot.cjs')).checkPolyglot(positionals);
  const settings = loadSettings({ directory: process.cwd(), explicit: values['loadwise-config'] });
  // The polyglot scan reports skippedFiles as a count, which printing never reads but the JSON
  // output keeps.
  const printable: Omit<PolyglotScan, 'skippedFiles'> = result;
  const code = printResult(printable, { ...values, ignore: [], settings });
  notifyEditor(positionals.length === 1 ? positionals[0] : process.cwd());
  return code;
}

async function main(args: readonly string[]): Promise<number> {
  // Resolve subcommand dependencies only after selecting the command.
  switch (args[0]) {
    case 'editor':
      return runEditor(args.slice(1));
    case 'agent':
      return runAgentCommand(args.slice(1));
    case 'migrations':
      return (await import('./migrations/cli.cjs')).run(args.slice(1));
    case 'contracts':
      return (await import('./contracts/cli.cjs')).run(args.slice(1));
    case 'db':
      return (await import('./db/cli.cjs')).run(args.slice(1));
    case 'traces':
      return checkTraces(args.slice(1));
    case 'plan':
      return checkPlan(args.slice(1));
    case 'polyglot':
      return runPolyglot(args.slice(1));
  }
  const { args: sourceArgs, ...baselineOptions } = extractBaselineFlags(args);
  return checkCode(sourceArgs, printResult, baselineOptions);
}

function printEmptyChangedReport(values: Pick<SourceCheckValues, 'format' | 'json' | 'with'>): void {
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

// Raw SQL index rules parse synchronously during the scan, and the WASM parser can only load
// asynchronously.
async function loadSqlParser(): Promise<void> {
  return (await import('./sql/pg-parser.cjs')).ensureLoaded();
}

export { main, sourcePolicy, workspaceTarget, projectDirectory, scanFilter, relativeToCwd };
