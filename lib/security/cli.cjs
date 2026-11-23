'use strict';

// `loadwise sec`: flag parsing, policy discovery, the security scan, the report and its exit code.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { securityRules, contractRules } = require('./rule-ids.cjs');
const { baselineForScan, extractBaselineFlags } = require('../shared/baseline.cjs');
const { loadSettings } = require('../shared/config.cjs');
const { resolveFormat } = require('../shared/formats/index.cjs');
const { parseMinImpact } = require('../shared/impact-levels.cjs');
const { fixPresentation } = require('../shared/fix-presentation.cjs');
const { exitCodeWithSkips } = require('../performance/scan-outcome.cjs');

const usage = `Usage:
  loadwise sec [-p tsconfig.json | -p monorepo-root [--workspace name|path ...] | file.ts file.js ...] [--policy policy.json] [--loadwise-config loadwise.config.json] [--json | --format text|json|sarif|github] [--min-impact low|medium|high|critical] [--baseline [file] | --write-baseline [file]] [--include-contextual] [--ignore rule-id] [--fail-on all|contract] [--fix [--yes | --only id,...] [--no-comments] [--no-format]]
  loadwise sec deps [--online] [directory] [--format text|json] [--json] [--include-contextual] [--ignore rule-id]
  loadwise sec [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]

With no arguments, check tsconfig.json or jsconfig.json in the current directory. File checks can run without either.
Security checks read prismaScopes and drizzleScopes from backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
Security checks always use the TypeScript 6 compiler. Rules that need a package's types stay silent until it is installed; rules that recognise libraries by their imports work without node_modules.
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
};

const pillar = { command: 'sec', contractRules };
// Loaded on first use: the rule modules bind the compiler, which `--help` and `--ignore` validation do not need.
const analyzer = {
  pillar: 'security',
  analyzeFile: (...args) => require('./analyze.cjs').analyzeFile(...args),
};

function parseSecurityArgs(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  if (values.help) return { values, positionals };
  if (values.project && positionals.length) throw new Error('Choose either a project or explicit source files.');
  if (!['all', 'contract'].includes(values['fail-on'])) throw new Error('--fail-on must be all or contract.');
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
  const { knownRules } = require('../performance/rule-ids.cjs');
  for (const ruleId of values.ignore) {
    if (!securityRules.includes(ruleId) && !knownRules.has(ruleId)) throw new Error('Unknown source rule: ' + ruleId);
  }
  return { values, positionals };
}

// Secrets, Dockerfile and compose checks read the project folder rather than the TypeScript program, so they run for
// a project (not for explicit source files) and report next to the code findings.
function scanFiles(values, positionals, workspace, isChangedFile) {
  if (positionals.length) return { scannedFiles: 0, findings: [] };
  const project = path.resolve(values.project ?? '.');
  const root = fs.statSync(project).isDirectory() ? project : path.dirname(project);
  const { scanProjectFiles } = require('./files/index.cjs');
  const roots = values.workspace.length ? workspace.configs.map((config) => path.dirname(config)) : [root];
  const isIgnored = values.settings?.isIgnored;
  return scanProjectFiles(roots, isChangedFile, isIgnored && ((file) => isIgnored(process.cwd(), file)));
}

function changedScope(values) {
  if (!values.staged && values['changed-since'] === undefined) return;
  const { collectProjectChangedLines, fileKey } = require('../performance/changed-lines.cjs');
  const changedLines = collectProjectChangedLines(
    { staged: values.staged, ref: values['changed-since'], allFiles: true },
    values.project,
  );
  return { changedLines, isChangedFile: (filename) => changedLines.has(fileKey(filename)) };
}

async function scanProjectSources(values, positionals, scope) {
  const {
    sourcePolicy,
    workspaceTarget,
    projectDirectory,
    scanFilter,
    relativeToCwd,
  } = require('../performance/cli.cjs');
  const {
    coveringConfig,
    projectConfig,
    plainJavaScriptSources,
    isProjectDirectory,
  } = require('../shared/workspaces.cjs');
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
  require('node:module').enableCompileCache?.();
  const inferredFiles = filesOnly ? plainJavaScriptSources(input) : undefined;
  const result =
    filesOnly && !inferredFiles
      ? { scannedFiles: 0, findings: [] }
      : require('../performance/projects.cjs').analyzeSources({
          project: workspace?.configs ?? values.project,
          files: inferredFiles ?? positionals,
          policy: sourcePolicy(values.policy, directory, values.settings).read(),
          onlyFiles: scanFilter(values.settings, scope),
          analyzers: [analyzer],
        });
  if (workspace) result.packages = workspace.packages;
  return { workspace, project, directory, filesOnly, result };
}

function assertBaselineAndScopeCompatible(baselineOptions, values, scope) {
  if ((baselineOptions.baseline || baselineOptions.writeBaseline) && values.fix) {
    throw new Error('--baseline and --write-baseline cannot be combined with --fix.');
  }
  if (baselineOptions.writeBaseline && scope) {
    throw new Error('--write-baseline records every finding; it cannot be combined with --staged or --changed-since.');
  }
}

// With nothing changed there is nothing to scan, so text and json output can be answered without loading the compiler.
function printEmptyChangedScope(values, scope, format) {
  if (!scope || scope.changedLines.size || values.online || !['text', 'json'].includes(format)) return false;
  console.log(format === 'json' ? '{"scannedFiles":0,"findings":[]}' : 'No changed JavaScript or TypeScript files.');
  return true;
}

async function addDependencyFindings(result, values, scope, directory, dependencyScanOptions) {
  if (!values.online) {
    if (!scope) require('./deps/cli.cjs').noteOffline(directory);
    return;
  }
  const dependencies = await require('./deps/scan.cjs').scanDependencies(directory, dependencyScanOptions);
  result.findings.push(...dependencies.findings);
  result.scannedFiles += dependencies.scannedFiles;
  result.scannedPackages = dependencies.scannedPackages;
}

function runFixMode({ result, project, directory }, values, positionals, format) {
  const report = require('../shared/source-report.cjs');
  report.assignFindingIds(result.findings, report.findingRoot(project));
  const historyProject = require('../shared/fix-history.cjs').sourceHistoryProject(directory, positionals);
  // Named ids are explicit, so they reach contextual and ignored findings too.
  if (values.onlyIds.length) {
    return require('../performance/fix-cli.cjs').applyChosenFixes(result.findings, values.onlyIds, {
      json: format === 'json',
      checker: 'sec',
      project: historyProject,
      ...fixPresentation(values),
    });
  }
  const findings = report.selectFindings(result, values);
  const validationReview = ({ ruleId }) => ruleId === 'nest-validation-without-whitelist';
  const withheld = values.yes ? findings.filter(validationReview) : [];
  const applicable = withheld.length ? findings.filter((finding) => !validationReview(finding)) : findings;
  if (withheld.length) console.log(`${withheld.length} validation whitelist finding(s) require individual review.`);
  return require('../performance/fix-cli.cjs').applyFixes(applicable, {
    all: values.yes,
    checker: 'sec',
    project: historyProject,
    withheld,
    ...fixPresentation(values),
  });
}

async function main(args, dependencyScanOptions) {
  if (args[0] === 'deps') return require('./deps/cli.cjs').main(args.slice(1), dependencyScanOptions);
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
  const report = require('../shared/source-report.cjs');
  if (values.fix)
    return exitCodeWithSkips(result, runFixMode({ result, project, directory }, values, positionals, format));
  const fixCommand = report.fixAllCommand('sec', project, positionals, values);
  const code = report.printResult(
    result,
    { ...values, project, projectDirectory: directory, baselineOptions, fixCommand, changedLines: scope?.changedLines },
    pillar,
  );
  return exitCodeWithSkips(result, code);
}

module.exports = { main, analyzer, scanFiles, pillar, usage };
