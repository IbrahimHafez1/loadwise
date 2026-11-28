import fs from 'node:fs';
import path from 'node:path';
import { rulesByPillar } from '../shared/rule-registry.js';
import { sourceCheckOptions, validateSourceOptions } from './source-options.js';
import { annotateImpact, filterMinImpact } from '../shared/impact-levels.js';
import { loadSettings } from '../shared/config.js';
import { baselineForScan } from '../shared/baseline.js';
import { resolveFormat } from '../shared/formats/index.js';
import { fixPresentation } from '../shared/fix-presentation.js';
import { editorAnalyzers, exitCodeWithSkips, noteEmptyIgnoredScan, reportSourceResult } from './scan-outcome.js';
import type { Finding, ScanResult } from '../shared/types.js';
import type { BaselineFlagOptions } from '../shared/types/baseline.js';
import type { SourceAnalyzer } from './types/source-analyzer.js';
import type { scanDependencies } from '../security/deps/scan.js';
import type { SourceCheckValues } from './types/source-check-values.js';
import type { ChangedScope } from './types/source-scan-values.js';
import { coveringConfig, configlessSources, projectConfig } from '../shared/workspaces.js';
import { enableCompileCache } from 'node:module';
import { notifyEditor } from '../shared/notify-editor.js';
import { sourceHistoryProject } from '../shared/fix-history.js';
import { applyChosenFixes, applyFixes } from './fix-cli.js';
import { findProjectRoot, loadSnapshot, useSnapshot } from './schema/context.js';
import * as sourceReport from '../shared/source-report.js';
import * as security from '../security/cli.js';
import { scanDependencies as scanDependenciesScan } from '../security/deps/scan.js';
import { noteOffline } from '../security/deps/cli.js';
import { projectDialect } from './schema/project-indexes.js';
import { checkSchemaFile, findPrismaSchemaFiles } from './schema/prisma-schema.js';
import {
  analyzeSources,
  performanceAnalyzers,
  preReadSources,
  accessibilityAnalyzer,
  reliabilityAnalyzer,
  reliabilityAnalyzers,
} from './projects.js';
import {
  accessibilityCommand,
  jsonKeyByCommand,
  performanceCommand,
  pillarOfFinding,
  reliabilityCommand,
  takePillar,
} from './source-pillars.js';
import type { EngineCommand } from './source-pillars.js';
import type { SourceCommand } from './types/source-command.js';
import { version as tsVersion } from 'typescript';
import { checkRedundantSchemaIndexes } from './redundant-indexes.js';
import { errorMessage, parseCommand, showHelp } from './cli-arguments.js';
import { reliabilityUsage } from '../reliability/usage.js';
import { accessibilityUsage } from '../accessibility/usage.js';
import { hasFrontendSources } from '../accessibility/frontend-detect.js';
import { isMarkupFile, scanMarkupFiles } from '../accessibility/markup-files.js';
import {
  assignFindingIds,
  findingRoot,
  printEmptyChangedReport,
  printResult,
  readChangedScope,
  scanFilter,
  selectFindings,
} from './cli-output.js';
import { projectDirectory, relativeToCwd, sourcePolicy, workspaceTarget } from './cli-policy.js';
import type {
  AnalyzedSource,
  CheckWithPillarsInput,
  ExitCodeReporter,
  FindingsReporter,
  PerformanceScanResult,
  PillarOutput,
  PolicySource,
  ScanSourceInput,
  ScanValues,
  SourceCodeOptions,
  WorkspaceTarget,
} from './cli-types.js';

const helpByCommand: Readonly<Record<EngineCommand['command'], string | undefined>> = {
  perf: undefined,
  rel: reliabilityUsage,
  a11y: accessibilityUsage,
};

// Accessibility has nothing in the performance analyzer, so it runs its own alone.
const analyzersByCommand: Readonly<Record<EngineCommand['command'], SourceAnalyzer[]>> = {
  perf: performanceAnalyzers,
  rel: reliabilityAnalyzers,
  a11y: [accessibilityAnalyzer],
};

function isConfiglessDirectory(project: string | undefined): boolean {
  const input = path.resolve(project ?? '.');
  const isDirectory = fs.statSync(input, { throwIfNoEntry: false })?.isDirectory() === true;
  return isDirectory && !projectConfig(input) && !coveringConfig(input);
}

// The accessibility checker has no program to analyze for a folder of plain markup, for markup files named alone, or
// for a project with no frontend sources, which would only cost a type-check.
interface SkipProgramInput {
  command: EngineCommand['command'];
  values: ScanValues;
  workspace: WorkspaceTarget | undefined;
  sourceFiles: readonly string[];
  markupFiles: readonly string[];
  inferredFiles: readonly string[] | undefined;
}

function skipsProgram({
  command,
  values,
  workspace,
  sourceFiles,
  markupFiles,
  inferredFiles,
}: SkipProgramInput): boolean {
  if (command !== 'a11y' || values.watch || sourceFiles.length) return false;
  if (markupFiles.length) return true;
  if (!workspace && !inferredFiles && isConfiglessDirectory(values.project)) return true;
  if (workspace) return !workspace.packages.some((workspacePackage) => hasFrontendSources(workspacePackage.directory));
  return !hasFrontendSources(values.projectDirectory);
}

interface MarkupScanInput {
  values: ScanValues;
  workspace: WorkspaceTarget | undefined;
  scope: ChangedScope | undefined;
  markupFiles: readonly string[];
  /** Whether TypeScript files were named on the command line, which limits the scan to them. */
  hasNamedSources: boolean;
}

// Markup files sit outside the TypeScript program, so their findings come from reading them after the scan. Markup
// files named on the command line are the only ones read; otherwise every one under the scanned folders is.
function markupScan({ values, workspace, scope, markupFiles, hasNamedSources }: MarkupScanInput): ScanResult {
  if (hasNamedSources && !markupFiles.length) return { scannedFiles: 0, findings: [] };
  const project = path.resolve(values.project ?? '.');
  const root = fs.statSync(project).isDirectory() ? project : path.dirname(project);
  const roots =
    workspace && values.workspace.length ? workspace.packages.map(({ directory }) => path.resolve(directory)) : [root];
  return scanMarkupFiles({
    roots: markupFiles.length ? [] : roots,
    explicitFiles: markupFiles,
    isScanned: scanFilter(values.settings, scope),
  });
}

function appendMarkupFindings(result: PerformanceScanResult, input: MarkupScanInput): void {
  const markup = markupScan(input);
  result.scannedFiles += markup.scannedFiles;
  result.findings.push(...markup.findings);
  if (markup.skippedFiles) result.skippedFiles = [...(result.skippedFiles ?? []), ...markup.skippedFiles];
}

export function checkCode(args: readonly string[], report: FindingsReporter): Promise<Finding[]>;

export function checkCode(
  args: readonly string[],
  report?: ExitCodeReporter,
  baselineFlags?: BaselineFlagOptions,
  pillar?: EngineCommand,
): Promise<number>;

// `pillar` is the checker the command reports: `loadwise perf`, `loadwise rel` or `loadwise a11y`.
export async function checkCode(
  args: readonly string[],
  report: ExitCodeReporter | FindingsReporter = printResult,
  baselineFlags: BaselineFlagOptions = {},
  pillar: EngineCommand = performanceCommand,
): Promise<number | Finding[]> {
  const { values: parsedValues, positionals: namedFiles } = parseCommand(args, sourceCheckOptions);
  if (parsedValues.help) return showHelp(helpByCommand[pillar.command]);
  // Markup files are not TypeScript inputs: accessibility reads them itself, beside the program.
  const markupFiles = pillar.command === 'a11y' ? namedFiles.filter(isMarkupFile) : [];
  const positionals = namedFiles.filter((file) => !markupFiles.includes(file));
  const baselineOptions = baselineForScan(
    baselineFlags,
    parsedValues,
    namedFiles.map((file) => path.resolve(file)),
  );
  const { engine, onlyIds, withCommands } = validateSourceOptions(
    parsedValues,
    namedFiles,
    baselineOptions,
    pillar.command,
  );
  const scope = readChangedScope(parsedValues, namedFiles, pillar.command === 'a11y');
  if (scope && !scope.changedLines.size && !parsedValues.online) {
    printEmptyChangedReport(parsedValues, [pillar.command, ...withCommands]);
    return 0;
  }
  await loadSqlParser();
  loadSchemaSnapshot(parsedValues.schema);
  const workspace = workspaceTarget(parsedValues, namedFiles);
  if (workspace && parsedValues.watch) throw new Error('--watch needs one project config, not a monorepo.');
  // The folder that names the project in ids, the policy lookup and the printed fix command.
  const project = workspace ? relativeToCwd(workspace.directory) : parsedValues.project;
  // Node reuses bytecode for the compiler across invocations. Each run still reads the current
  // project.
  enableCompileCache?.();
  const { directory, inferredFiles } = resolveScanInputs(
    parsedValues,
    namedFiles,
    workspace,
    pillar.command === 'a11y' && isConfiglessDirectory(parsedValues.project),
  );
  const values: ScanValues = {
    ...parsedValues,
    // CLI --ignore ids are filtered by selectFindings, so the settings only add the config's own
    // filters.
    settings: loadSettings({ directory, explicit: parsedValues['loadwise-config'] }),
    // The default baseline file sits in the same folder.
    projectDirectory: directory,
    sourcePillar: pillar.jsonKey,
  };
  const policySource = sourcePolicy(values.policy, values.settings);
  const policy = policySource.read();
  if (withCommands.length)
    return checkWithPillars({
      values,
      positionals,
      policy,
      scope,
      workspace,
      project,
      baselineOptions,
      inferredFiles,
      commands: [pillar.command, ...withCommands],
      markupFiles,
    });
  if (values.watch) return watchSource(values, policySource);
  const scanned = await scanSource({
    values,
    positionals,
    workspace,
    inferredFiles,
    policy,
    scope,
    engine,
    report,
    analyzers: analyzersByCommand[pillar.command],
    skipProgram: skipsProgram({
      command: pillar.command,
      values,
      workspace,
      sourceFiles: positionals,
      markupFiles,
      inferredFiles,
    }),
  });
  const { result } = scanned;
  if (pillar.command === 'a11y')
    appendMarkupFindings(result, {
      values,
      workspace,
      scope,
      markupFiles,
      hasNamedSources: positionals.length > 0,
    });
  if (workspace && workspace.packages.length > 1) result.packages = workspace.packages;
  noteEmptyIgnoredScan(result, values, scope);
  if (!positionals.length && pillar.command !== 'a11y')
    appendPrismaSchemaFindings(result, workspace?.configs ?? [project ?? '.'], scope);
  if (values.fix && report === printResult) {
    return exitCodeWithSkips(result, await applySourceFixes(result, values, onlyIds, project, namedFiles));
  }
  // The editor's reporter shows every pillar the pass found; the terminal report shows this checker's.
  if (report === printResult) result.findings = takePillar(result.findings, pillar.jsonKey);
  const code = await reportSourceResult({
    ...scanned,
    values,
    project,
    baselineOptions,
    positionals: namedFiles,
    scope,
    report,
    command: pillar.command,
  });
  if (report === printResult) notifyEditor(values.project ?? process.cwd());
  return code;
}

function resolveScanInputs(
  values: Pick<SourceCheckValues, 'project' | 'watch'>,
  positionals: readonly string[],
  workspace: WorkspaceTarget | undefined,
  readsMarkupOnly: boolean,
): { directory: string; inferredFiles: string[] | undefined } {
  // A monorepo root keeps its policy and config at the root, beside no project config.
  const input = path.resolve(values.project ?? '.');
  const inferredFiles = !workspace && !positionals.length && !values.watch ? configlessSources(input) : undefined;
  // A folder of plain markup has no project config to take its folder from.
  const isMarkupFolder = readsMarkupOnly && !workspace && !positionals.length;
  const directory =
    workspace?.directory ?? (inferredFiles || isMarkupFolder ? input : projectDirectory(values.project, positionals));
  return { directory, inferredFiles };
}

async function watchSource(values: ScanValues, policySource: PolicySource): Promise<number> {
  const { watchProject } = await import('./watch.js');
  const logError = (error: unknown) => {
    console.error(typeof error === 'object' && error !== null && 'message' in error ? error.message : error);
  };
  const watcher = watchProject(values.project ?? '.', {
    policySource,
    onResult(result) {
      appendPrismaSchemaFindings(result, [values.project ?? '.']);
      void printResult(result, values).catch(logError);
    },
    onError: logError,
  });
  const closeWatcher = () => {
    watcher.close();
  };
  process.once('SIGINT', closeWatcher);
  process.once('SIGTERM', closeWatcher);
  return 0;
}

async function scanSource({
  values,
  positionals,
  workspace,
  inferredFiles,
  policy,
  scope,
  engine,
  report,
  analyzers,
  skipProgram,
}: ScanSourceInput): Promise<AnalyzedSource> {
  if (skipProgram) return { result: { scannedFiles: 0, findings: [], engine: 'js' }, usedFallback: false };
  // The editor watcher checks repeatedly in one process, which keeps it on the JS compiler. It
  // shows the reliability and security findings too, from the same Program.
  const editor = report !== printResult;
  return await analyzeSourceCode(
    {
      project: inferredFiles ? [] : (workspace?.configs ?? values.project),
      files: positionals,
      standaloneFiles: inferredFiles ?? workspace?.standaloneFiles,
      policy,
      onlyFiles: scanFilter(values.settings, scope),
      analyzers: editor ? await editorAnalyzers() : analyzers,
    },
    editor ? 'js' : engine,
  );
}

// Ids named for `perf --fix --only` from a report made before reliability had its own checker.
function movedReliabilityIds(findings: readonly Finding[], onlyIds: readonly string[]): Finding[] {
  return findings.filter(
    (finding) => finding.id !== undefined && onlyIds.includes(finding.id) && pillarOfFinding(finding) === 'reliability',
  );
}

function commandOfPillar(sourcePillar: ScanValues['sourcePillar']): EngineCommand {
  if (sourcePillar === 'reliability') return reliabilityCommand;
  return sourcePillar === 'accessibility' ? accessibilityCommand : performanceCommand;
}

function applySourceFixes(
  result: PerformanceScanResult,
  values: ScanValues,
  onlyIds: readonly string[],
  project: string | undefined,
  files: readonly string[],
): number | Promise<number> {
  const pillar = commandOfPillar(values.sourcePillar);
  assignFindingIds(result.findings, findingRoot(project));
  const historyProject = sourceHistoryProject(values.projectDirectory, files);
  const moved = pillar.command === 'perf' ? movedReliabilityIds(result.findings, onlyIds) : [];
  if (moved.length) {
    const ids = moved.map(({ id }) => id).join(', ');
    console.error(
      `Note: ${ids} now belong to the reliability checker; fixing them anyway. Use \`loadwise rel --fix --only\` from now on.`,
    );
  }
  result.findings = [...takePillar(result.findings, pillar.jsonKey), ...takePillar(moved, 'reliability')];
  // Named ids are explicit, so they reach contextual and ignored findings too.
  if (onlyIds.length) {
    return applyChosenFixes(result.findings, onlyIds, {
      json: resolveFormat(values) === 'json',
      checker: pillar.command,
      project: historyProject,
      ...fixPresentation(values),
    });
  }
  // --fix offers exactly the findings the report would show, so --min-impact narrows it too.
  selectFindings(result, values);
  result.findings = filterMinImpact(
    annotateImpact(result.findings, rulesByPillar[pillar.jsonKey].impactByRule),
    values['min-impact'],
  );
  return applyFixes(result.findings, {
    all: values.yes,
    checker: pillar.command,
    project: historyProject,
    ...fixPresentation(values),
  });
}

// The analyzers one pass needs for the selected checkers. Reliability always runs with the
// performance analyzer, which still finds some of its rules.
function sharedAnalyzers(commands: readonly SourceCommand[]): SourceAnalyzer[] {
  const needsPerformance = commands.includes('perf') || commands.includes('rel');
  return [
    ...(needsPerformance ? performanceAnalyzers : []),
    ...(commands.includes('rel') ? [reliabilityAnalyzer] : []),
    ...(commands.includes('sec') ? [security.analyzer] : []),
    ...(commands.includes('a11y') ? [accessibilityAnalyzer] : []),
  ];
}

// `check` runs perf, rel, sec and a11y together through `--with`, so the project is type-checked once on
// the JS compiler. Prints { performance: { code, stdout }, reliability: ..., security: ..., accessibility: ... } with a key
// per selected checker, for the parent to split.
async function checkWithPillars({
  values,
  positionals,
  policy,
  scope,
  workspace,
  project,
  baselineOptions,
  inferredFiles,
  commands,
  markupFiles,
}: CheckWithPillarsInput): Promise<number> {
  const preRead = await preReadSources({
    project: workspace?.configs ?? values.project,
    files: inferredFiles ?? positionals,
  });
  const result: PerformanceScanResult = analyzeSources({
    project: inferredFiles ? [] : (workspace?.configs ?? values.project),
    files: positionals,
    standaloneFiles: inferredFiles ?? workspace?.standaloneFiles,
    policy,
    onlyFiles: scanFilter(values.settings, scope),
    analyzers: sharedAnalyzers(commands),
    preRead,
  });
  if (!positionals.length && commands.some((command) => command !== 'a11y'))
    appendPrismaSchemaFindings(result, workspace?.configs ?? [project ?? '.'], scope);
  if (workspace) result.packages = workspace.packages;
  const markup: ScanResult = commands.includes('a11y')
    ? markupScan({ values, workspace, scope, markupFiles, hasNamedSources: positionals.length > 0 })
    : { scannedFiles: 0, findings: [] };
  const withSecurity = commands.includes('sec');
  const fileFindings = withSecurity
    ? security.scanFiles(values, positionals, workspace, scope?.isChangedFile).findings
    : [];
  let dependencies: Awaited<ReturnType<typeof scanDependencies>> | undefined;
  let dependencyError: unknown;
  if (withSecurity && values.online) {
    try {
      dependencies = await scanDependenciesScan(values.projectDirectory);
    } catch (error) {
      dependencyError = error;
    }
  } else if (withSecurity && !scope) {
    noteOffline(values.projectDirectory);
  }
  async function reportPillar(command: SourceCommand): Promise<PillarOutput> {
    const jsonKey = jsonKeyByCommand[command];
    const isSecurity = command === 'sec';
    if (isSecurity && dependencyError) {
      console.error(errorMessage(dependencyError));
      return { code: 2, stdout: '' };
    }
    const findings = takePillar(result.findings, jsonKey);
    if (isSecurity) findings.push(...fileFindings, ...(dependencies?.findings ?? []));
    if (command === 'a11y') findings.push(...markup.findings);
    const reportResult: PerformanceScanResult = { ...result, findings };
    if (command === 'a11y') {
      reportResult.scannedFiles += markup.scannedFiles;
      if (markup.skippedFiles)
        reportResult.skippedFiles = [...(reportResult.skippedFiles ?? []), ...markup.skippedFiles];
    }
    if (isSecurity && dependencies) {
      reportResult.scannedFiles += dependencies.scannedFiles;
      reportResult.scannedPackages = dependencies.scannedPackages;
    }
    const pillarValues: ScanValues = {
      ...values,
      project,
      baselineOptions,
      fixCommand: sourceReport.fixAllCommand(command, project, positionals, values),
      ...(command === 'rel' && { sourcePillar: 'reliability' }),
      ...(command === 'a11y' && { sourcePillar: 'accessibility' }),
      ...(scope && { changedLines: scope.changedLines }),
    };
    const lines: string[] = [];
    const print = (line: string): void => {
      lines.push(line);
    };
    const code = exitCodeWithSkips(
      reportResult,
      isSecurity
        ? await sourceReport.printResult(reportResult, pillarValues, security.pillar, print)
        : await printResult(reportResult, pillarValues, print),
    );
    return { code, stdout: lines.map((line) => line + '\n').join('') };
  }
  const outputs = await Promise.all(commands.map((command) => reportPillar(command)));
  const reports = Object.fromEntries(commands.map((command, index) => [jsonKeyByCommand[command], outputs[index]]));
  console.log(JSON.stringify(reports));
  notifyEditor(values.project ?? process.cwd());
  return Math.max(...outputs.map(({ code }) => code));
}

// schema.prisma is not TypeScript, so its foreign-key findings come from the parsed schema after
// the scan.
function appendPrismaSchemaFindings(
  result: Pick<PerformanceScanResult, 'findings'>,
  projects: readonly string[],
  scope?: ChangedScope,
): void {
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
async function analyzeSourceCode(options: SourceCodeOptions, engine: string): Promise<AnalyzedSource> {
  if (engine === 'js') {
    const preRead = await preReadSources(options);
    return { result: { ...analyzeSources({ ...options, preRead }), engine }, usedFallback: false };
  }
  const { analyzeNative } = await import('./native.js');
  const result = analyzeNative({
    ...options,
    fallback: engine === 'auto',
  });
  if (!result.fallback) return { result: { ...result, engine: 'native' }, usedFallback: false };
  const preRead = await preReadSources(options);
  const fallbackResult = analyzeSources({ ...options, preRead });
  if (result.reason) {
    console.error(
      `Note: TypeScript 7 cannot load this project (${firstReason(result.reason)}); used TypeScript ${tsVersion}.`,
    );
  } else {
    console.error('Note: the TypeScript 7 native compiler is not available; used the JS engine.');
  }
  return { result: { ...fallbackResult, engine: 'js' }, usedFallback: true };
}

// Raw SQL index rules parse synchronously during the scan, and the WASM parser can only load
// asynchronously.
export async function loadSqlParser(): Promise<void> {
  return (await import('./sql/pg-parser.js')).ensureLoaded();
}
