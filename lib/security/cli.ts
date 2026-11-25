// `loadwise sec`: flag parsing, policy discovery, the security scan, the report and its exit code.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';
import { securityRules, contractRules } from './rule-ids.js';
import { baselineForScan, extractBaselineFlags } from '../shared/baseline.js';
import { loadSettings } from '../shared/config.js';
import { resolveFormat } from '../shared/formats/index.js';
import { parseMinImpact } from '../shared/impact-levels.js';
import { fixPresentation } from '../shared/fix-presentation.js';
import { exitCodeWithSkips } from '../performance/scan-outcome.js';
import type { Finding, ScanResult } from '../shared/types.js';
import type { LoadwiseSettings } from '../shared/types/settings.js';
import type { ChangedLines, SourceReportPillar, SourceReportResult } from '../shared/types/source-report.js';
import type { SourceAnalyzer } from '../performance/types/source-analyzer.js';
import type { PathPredicate } from './types/project-files.js';
import type { VulnerabilityLookupOptions } from './types/osv-vulnerability.js';
import { knownRules } from '../performance/rule-ids.js';
import { collectProjectChangedLines, fileKey } from '../performance/changed-lines.js';
import { sourcePolicy, workspaceTarget, projectDirectory, scanFilter, relativeToCwd } from '../performance/cli.js';
import { coveringConfig, projectConfig, plainJavaScriptSources, isProjectDirectory } from '../shared/workspaces.js';
import { enableCompileCache } from 'node:module';
import { noteOffline, main as mainCli } from './deps/cli.js';
import { scanDependencies } from './deps/scan.js';
import { analyzeFile as analyzeSecurityFile } from './analyze.js';
import { scanProjectFiles } from './files/index.js';
import { analyzeSources, preReadSources } from '../performance/projects.js';
import * as report from '../shared/source-report.js';
import { sourceHistoryProject } from '../shared/fix-history.js';
import { applyChosenFixes, applyFixes } from '../performance/fix-cli.js';
import type * as Projects from '../performance/projects.js';
import type * as Cli from '../performance/cli.js';

const usage = `Usage:
  loadwise sec [-p tsconfig.json | -p monorepo-root [--workspace name|path ...] | file.ts file.js ...] [--engine auto|native|js] [--policy policy.json] [--loadwise-config loadwise.config.json] [--json | --format text|json|sarif|github] [--min-impact low|medium|high|critical] [--baseline [file] | --write-baseline [file]] [--include-contextual] [--ignore rule-id] [--fail-on all|contract] [--fix [--yes | --only id,...] [--no-comments] [--no-format]]
  loadwise sec deps [--online] [directory] [--format text|json] [--json] [--include-contextual] [--ignore rule-id]
  loadwise sec [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]

With no arguments, check tsconfig.json or jsconfig.json in the current directory. File checks can run without either.
Security checks read prismaScopes and drizzleScopes from backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
Source checks use TypeScript 6 (--engine auto and js). --engine native (alias --native) uses the TypeScript 7 native compiler, which is faster but finds less: cross-file taint through JavaScript constructor functions and rate-limit detection are reduced. Rules that need a package's types stay silent until it is installed; rules that recognise libraries by their imports work without node_modules.
--fix shows each available code fix and asks before applying it; --fix --yes skips the ValidationPipe whitelist change.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
--fix adds a "// Loadwise <rule-id>: <why>" comment above each fixed statement and formats the changed lines with the project's Prettier; --no-comments and --no-format turn these off.
--staged and --changed-since report only findings on lines changed in the git index or since a ref, with a fix and a dismiss command per finding.
--online also checks the lockfile's packages against the OSV vulnerability database (only names and versions are sent; see loadwise sec deps -h); without it dependency checks are skipped with a note.
--include-contextual includes contextual findings (test sources, reviewed lines) with their reasons.
--ignore accepts any loadwise rule id. --fail-on contract exits 1 only for contract rules; no security rule is one yet.
Exit codes: 0 passed, 1 findings meeting the exit threshold, 2 invalid input or configuration.`;

const options = {
  help: { type: 'boolean', short: 'h' },
  project: { type: 'string', short: 'p' },
  native: { type: 'boolean' },
  engine: { type: 'string' },
  policy: { type: 'string' },
  workspace: { type: 'string', multiple: true, default: [] },
  'loadwise-config': { type: 'string' },
  format: { type: 'string' },
  'min-impact': { type: 'string' },
  'fail-on': { type: 'string', default: 'all' },
  'include-contextual': { type: 'boolean', default: false },
  json: { type: 'boolean' },
  online: { type: 'boolean' },
  ignore: { type: 'string', multiple: true, default: [] },
  fix: { type: 'boolean' },
  yes: { type: 'boolean' },
  only: { type: 'string', multiple: true, default: [] },
  comments: { type: 'boolean' },
  'no-comments': { type: 'boolean' },
  'no-format': { type: 'boolean' },
  staged: { type: 'boolean' },
  'changed-since': { type: 'string' },
} satisfies ParseArgsOptionsConfig;

// The parsed command line, plus what the later steps derive from it: the engine, the finding ids
// named by --only and the config settings.
interface SecurityFlags {
  help?: boolean;
  project?: string;
  native?: boolean;
  engine?: string;
  policy?: string;
  workspace: string[];
  'loadwise-config'?: string;
  format?: string;
  'min-impact'?: string;
  'fail-on': string;
  'include-contextual': boolean;
  json?: boolean;
  online?: boolean;
  ignore: string[];
  fix?: boolean;
  yes?: boolean;
  only: string[];
  comments?: boolean;
  'no-comments'?: boolean;
  'no-format'?: boolean;
  staged?: boolean;
  'changed-since'?: string;
  sourceEngine: SourceEngine;
  onlyIds: string[];
  settings?: LoadwiseSettings;
}

type SourceEngine = 'auto' | 'native' | 'js';

// The files and line ranges `--staged` and `--changed-since` limit the scan to.
interface ChangedScope {
  changedLines: ChangedLines;
  isChangedFile: PathPredicate;
}

type SourceScanOptions = Parameters<typeof Projects.analyzeSources>[0];
type WorkspaceTarget = NonNullable<ReturnType<typeof Cli.workspaceTarget>>;

// Everything the sources step learned that the later steps report on.
interface SourceScan {
  workspace: WorkspaceTarget | undefined;
  project: string | undefined;
  directory: string;
  filesOnly: boolean;
  result: SourceReportResult & { scannedPackages?: number };
}

const pillar: SourceReportPillar = { command: 'sec', contractRules };
// Loaded on first use: the rule modules bind the compiler, which `--help` and `--ignore` validation
// do not need.
const analyzer: SourceAnalyzer = {
  pillar: 'security',
  analyzeFile: (program, sourceFile, policy) => analyzeSecurityFile(program, sourceFile, policy),
};

// The same choices as `loadwise perf --engine`.
function isSourceEngine(engine: string): engine is SourceEngine {
  return engine === 'auto' || engine === 'native' || engine === 'js';
}

function sourceEngine(values: Pick<SecurityFlags, 'native' | 'engine'>): SourceEngine {
  if (values.native && (values.engine ?? 'native') !== 'native')
    throw new Error('--native is an alias for --engine native.');
  const engine = values.native ? 'native' : (values.engine ?? 'auto');
  if (!isSourceEngine(engine)) throw new Error('--engine must be auto, native or js.');
  return engine;
}

function parseSecurityArgs(args: readonly string[]): { values: SecurityFlags; positionals: string[] } {
  const parsed = parseArgs({ args, allowPositionals: true, options });
  const { positionals } = parsed;
  const values: SecurityFlags = { ...parsed.values, sourceEngine: 'auto', onlyIds: [] };
  if (values.help) return { values, positionals };
  if (values.project && positionals.length) throw new Error('Choose either a project or explicit source files.');
  if (!['all', 'contract'].includes(values['fail-on'])) throw new Error('--fail-on must be all or contract.');
  values.sourceEngine = sourceEngine(values);
  values.onlyIds = values.only
    .flatMap((list) => list.split(','))
    .map((id) => id.trim())
    .filter(Boolean);
  if (values.only.length && !values.fix) throw new Error('--only is only valid with --fix.');
  if (values.only.length && !values.onlyIds.length) throw new Error('--only needs at least one finding id.');
  const format = resolveFormat(values);
  parseMinImpact(values['min-impact']);
  if (values.fix && ['sarif', 'github'].includes(format))
    throw new Error('--format sarif and github cannot be combined with --fix.');
  if (values.fix && format === 'json' && !values.onlyIds.length)
    throw new Error('--fix prints a report with --json only with --only.');
  if (values.yes && !values.fix) throw new Error('--yes is only valid with --fix.');
  if ((values.comments || values['no-comments'] || values['no-format']) && !values.fix)
    throw new Error('--comments, --no-comments and --no-format are only valid with --fix.');
  if (values.staged && values['changed-since'] !== undefined)
    throw new Error('Choose either --staged or --changed-since.');
  const changed = values.staged || values['changed-since'] !== undefined;
  if (changed && (positionals.length || values.fix))
    throw new Error('--staged and --changed-since cannot be combined with explicit files or --fix.');
  for (const ruleId of values.ignore) {
    if (!securityRules.includes(ruleId) && !knownRules.has(ruleId)) throw new Error('Unknown source rule: ' + ruleId);
  }
  return { values, positionals };
}

// Secrets, Dockerfile and compose checks read the project folder rather than the TypeScript
// program, so they run for a project (not for explicit source files) and report next to the code
// findings.
function scanFiles(
  values: Pick<SecurityFlags, 'project' | 'workspace' | 'settings'>,
  positionals: readonly string[],
  workspace: WorkspaceTarget | undefined,
  isChangedFile?: PathPredicate,
): ScanResult {
  if (positionals.length) return { scannedFiles: 0, findings: [] };
  const project = path.resolve(values.project ?? '.');
  const root = fs.statSync(project).isDirectory() ? project : path.dirname(project);
  const roots = workspace && values.workspace.length ? workspace.configs.map((config) => path.dirname(config)) : [root];
  const isIgnored = values.settings?.isIgnored;
  return scanProjectFiles(roots, isChangedFile, isIgnored && ((file) => isIgnored(process.cwd(), file)));
}

function changedScope(values: SecurityFlags): ChangedScope | undefined {
  if (!values.staged && values['changed-since'] === undefined) return;
  const changedLines = collectProjectChangedLines(
    { staged: values.staged, ref: values['changed-since'], allFiles: true },
    values.project,
  );
  return { changedLines, isChangedFile: (filename: string) => changedLines.has(fileKey(filename)) };
}

async function scanProjectSources(
  values: SecurityFlags,
  positionals: string[],
  scope: ChangedScope | undefined,
): Promise<SourceScan> {
  const workspace = workspaceTarget(values, positionals);
  const project = workspace ? relativeToCwd(workspace.directory) : values.project;
  const input = path.resolve(values.project ?? '.');
  const filesOnly =
    !workspace &&
    !positionals.length &&
    (await isProjectDirectory(input)) &&
    !projectConfig(input) &&
    !coveringConfig(input);
  const directory = filesOnly ? input : (workspace?.directory ?? projectDirectory(values.project, positionals));
  values.settings = loadSettings({ directory, explicit: values['loadwise-config'] });
  enableCompileCache?.();
  const inferredFiles = filesOnly ? plainJavaScriptSources(input) : undefined;
  const result: SourceScan['result'] =
    filesOnly && !inferredFiles
      ? { scannedFiles: 0, findings: [] }
      : await analyzeWithEngine(
          {
            project: workspace?.configs ?? values.project,
            files: inferredFiles ?? positionals,
            policy: sourcePolicy(values.policy, directory, values.settings).read(),
            onlyFiles: scanFilter(values.settings, scope),
            analyzers: [analyzer],
          },
          values.sourceEngine,
        );
  if (workspace) result.packages = workspace.packages;
  return { workspace, project, directory, filesOnly, result };
}

const nativeCoverageNote =
  'Note: the TypeScript 7 native engine finds less than the JS engine: cross-file taint through JavaScript constructor functions (for example NodeGoat nosql-operator-injection) and rate-limit detection are reduced.';

// auto and js use TypeScript 6, which finds more; native runs only when asked for. Loading the JS
// engine binds the shared rules to TypeScript 6, so it is required only when native is not chosen.
async function analyzeWithEngine(options: SourceScanOptions, engine: SourceEngine): Promise<ScanResult> {
  if (engine !== 'native') {
    const preRead = await preReadSources(options);
    return analyzeSources({ ...options, preRead });
  }
  console.error(nativeCoverageNote);
  const { analyzeNative } = await import('../performance/native.js');
  const outcome = analyzeNative(options);
  // A fallback is only offered when the caller asks for one, which this scan does not.
  if (outcome.fallback) throw new Error(outcome.reason ?? 'The native engine is unavailable.');
  return outcome;
}

function assertBaselineAndScopeCompatible(
  baselineOptions: ReturnType<typeof baselineForScan>,
  values: SecurityFlags,
  scope: ChangedScope | undefined,
) {
  if ((baselineOptions.baseline || baselineOptions.writeBaseline) && values.fix) {
    throw new Error('--baseline and --write-baseline cannot be combined with --fix.');
  }
  if (baselineOptions.writeBaseline && scope) {
    throw new Error('--write-baseline records every finding; it cannot be combined with --staged or --changed-since.');
  }
}

// With nothing changed there is nothing to scan, so text and json output can be answered without
// loading the compiler.
function printEmptyChangedScope(values: SecurityFlags, scope: ChangedScope | undefined, format: string) {
  if (!scope || scope.changedLines.size || values.online || !['text', 'json'].includes(format)) return false;
  console.log(format === 'json' ? '{"scannedFiles":0,"findings":[]}' : 'No changed JavaScript or TypeScript files.');
  return true;
}

async function addDependencyFindings(
  result: SourceScan['result'],
  values: SecurityFlags,
  scope: ChangedScope | undefined,
  directory: string,
  dependencyScanOptions?: VulnerabilityLookupOptions,
) {
  if (!values.online) {
    if (!scope) noteOffline(directory);
    return;
  }
  const dependencies = await scanDependencies(directory, dependencyScanOptions);
  result.findings.push(...dependencies.findings);
  result.scannedFiles += dependencies.scannedFiles;
  result.scannedPackages = dependencies.scannedPackages;
}

function runFixMode(
  { result, project, directory }: Pick<SourceScan, 'result' | 'project' | 'directory'>,
  values: SecurityFlags,
  positionals: readonly string[],
  format: string,
) {
  report.assignFindingIds(result.findings, report.findingRoot(project));
  const historyProject = sourceHistoryProject(directory, positionals);
  // Named ids are explicit, so they reach contextual and ignored findings too.
  if (values.onlyIds.length) {
    return applyChosenFixes(result.findings, values.onlyIds, {
      json: format === 'json',
      checker: 'sec',
      project: historyProject,
      ...fixPresentation(values),
    });
  }
  const findings = report.selectFindings(result, { ...values, projectDirectory: directory });
  const validationReview = ({ ruleId }: Finding) => ruleId === 'nest-validation-without-whitelist';
  const withheld = values.yes ? findings.filter(validationReview) : [];
  const applicable = withheld.length ? findings.filter((finding: Finding) => !validationReview(finding)) : findings;
  if (withheld.length) console.log(`${withheld.length} validation whitelist finding(s) require individual review.`);
  return applyFixes(applicable, {
    all: values.yes,
    checker: 'sec',
    project: historyProject,
    withheld,
    ...fixPresentation(values),
  });
}

async function main(args: readonly string[], dependencyScanOptions?: VulnerabilityLookupOptions) {
  if (args[0] === 'deps') return mainCli(args.slice(1), dependencyScanOptions);
  const { args: sourceArgs, ...baselineFlags } = extractBaselineFlags(args);
  const { values, positionals } = parseSecurityArgs(sourceArgs);
  const baselineOptions = baselineForScan(
    baselineFlags,
    values,
    positionals.map((file) => path.resolve(file)),
  );
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const scope = changedScope(values);
  assertBaselineAndScopeCompatible(baselineOptions, values, scope);
  const format = resolveFormat(values);
  if (printEmptyChangedScope(values, scope, format)) return 0;
  const { workspace, project, directory, filesOnly, result } = await scanProjectSources(values, positionals, scope);
  await addDependencyFindings(result, values, scope, directory, dependencyScanOptions);
  const fileReport = scanFiles(values, positionals, workspace, scope?.isChangedFile);
  if (filesOnly) result.scannedFiles += fileReport.scannedFiles;
  result.findings.push(...fileReport.findings);
  if (values.fix)
    return exitCodeWithSkips(result, await runFixMode({ result, project, directory }, values, positionals, format));
  const fixCommand = report.fixAllCommand('sec', project, positionals, values);
  const code = report.printResult(
    result,
    { ...values, project, projectDirectory: directory, baselineOptions, fixCommand, changedLines: scope?.changedLines },
    pillar,
  );
  return exitCodeWithSkips(result, code);
}

export { main, analyzer, scanFiles, pillar, usage };
