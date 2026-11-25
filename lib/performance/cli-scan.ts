import path from 'node:path';
import { impactByRule } from './rule-ids.js';
import { sourceCheckOptions, validateSourceOptions } from './source-options.js';
import { annotateImpact, filterMinImpact } from '../shared/impact-levels.js';
import { loadSettings } from '../shared/config.js';
import { baselineForScan } from '../shared/baseline.js';
import { resolveFormat } from '../shared/formats/index.js';
import { contractRules } from '../shared/formats/contract-rules.js';
import { fixPresentation } from '../shared/fix-presentation.js';
import { editorAnalyzers, exitCodeWithSkips, noteEmptyIgnoredScan, reportSourceResult } from './scan-outcome.js';
import type { Finding } from '../shared/types.js';
import type { BaselineFlagOptions } from '../shared/types/baseline.js';
import type { SourceReportPillar } from '../shared/types/source-report.js';
import type { scanDependencies } from '../security/deps/scan.js';
import type { SourceCheckValues } from './types/source-check-values.js';
import type { ChangedScope } from './types/source-scan-values.js';
import { plainJavaScriptSources } from '../shared/workspaces.js';
import { enableCompileCache } from 'node:module';
import { notifyEditor } from './notify-editor.js';
import { sourceHistoryProject } from '../shared/fix-history.js';
import { applyChosenFixes, applyFixes } from './fix-cli.js';
import { findProjectRoot, loadSnapshot, useSnapshot } from './schema/context.js';
import * as sourceReport from '../shared/source-report.js';
import * as security from '../security/cli.js';
import { scanDependencies as scanDependenciesScan } from '../security/deps/scan.js';
import { noteOffline } from '../security/deps/cli.js';
import { projectDialect } from './schema/project-indexes.js';
import { checkSchemaFile, findPrismaSchemaFiles } from './schema/prisma-schema.js';
import { analyzeSources, performanceAnalyzers } from './projects.js';
import { version as tsVersion } from 'typescript';
import { checkRedundantSchemaIndexes } from './redundant-indexes.js';
import { errorMessage, parseCommand, showHelp } from './cli-arguments.js';
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
  CheckWithSecurityInput,
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

export function checkCode(args: readonly string[], report: FindingsReporter): Promise<Finding[]>;

export function checkCode(
  args: readonly string[],
  report?: ExitCodeReporter,
  baselineFlags?: BaselineFlagOptions,
): Promise<number>;

export async function checkCode(
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
  const scanned = await scanSource({ values, positionals, workspace, inferredFiles, policy, scope, engine, report });
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
  const { watchProject } = await import('./watch.js');
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

async function scanSource({
  values,
  positionals,
  workspace,
  inferredFiles,
  policy,
  scope,
  engine,
  report,
}: ScanSourceInput): Promise<AnalyzedSource> {
  // The editor watcher checks repeatedly in one process, which keeps it on the JS compiler. It
  // shows the security findings too, from the same Program.
  const analyzers = report !== printResult && (await editorAnalyzers());
  return await analyzeSourceCode(
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
  if (engine === 'js') return { result: { ...analyzeSources(options), engine }, usedFallback: false };
  const { analyzeNative } = await import('./native.js');
  const result = analyzeNative({
    ...options,
    fallback: engine === 'auto',
  });
  if (!result.fallback) return { result: { ...result, engine: 'native' }, usedFallback: false };
  const fallbackResult = analyzeSources(options);
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
