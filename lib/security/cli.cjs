'use strict';

// `loadwise sec`: flag parsing, policy discovery, the security scan, the report and its exit code.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { securityRules, contractRules } = require('./rule-ids.cjs');
const { extractBaselineFlags } = require('../shared/baseline.cjs');
const { loadSettings } = require('../shared/config.cjs');
const { resolveFormat } = require('../shared/formats/index.cjs');
const { parseMinImpact } = require('../shared/impact-levels.cjs');

const usage = `Usage:
  loadwise sec [-p tsconfig.json | -p monorepo-root [--workspace name|path ...] | file.ts file.js ...] [--policy policy.json] [--loadwise-config loadwise.config.json] [--json | --format text|json|sarif|github] [--min-impact low|medium|high|critical] [--baseline [file] | --write-baseline [file]] [--include-contextual] [--ignore rule-id] [--fail-on all|contract] [--fix [--yes | --only id,...]]
  loadwise sec deps [--online] [directory] [--format text|json] [--json] [--include-contextual] [--ignore rule-id]
  loadwise sec [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]

With no arguments, check tsconfig.json or jsconfig.json in the current directory.
Security checks read prismaScopes and drizzleScopes from backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
Security checks always use the TypeScript 6 compiler. Rules that need a package's types stay silent until it is installed; rules that recognise libraries by their imports work without node_modules.
--fix shows each available code fix and asks before applying it; --fix --yes skips the ValidationPipe whitelist change.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
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
function fileFindings(values, positionals, workspace) {
  if (positionals.length) return [];
  const project = path.resolve(values.project ?? '.');
  const root = fs.statSync(project).isDirectory() ? project : path.dirname(project);
  const { scanProjectFiles } = require('./files/index.cjs');
  const roots = values.workspace.length ? workspace.configs.map((config) => path.dirname(config)) : [root];
  return roots.flatMap((directory) => scanProjectFiles(directory));
}

function changedScope(values) {
  if (!values.staged && values['changed-since'] === undefined) return;
  const { collectChangedLines, fileKey } = require('../performance/changed-lines.cjs');
  const changedLines = collectChangedLines({
    staged: values.staged,
    ref: values['changed-since'],
    allFiles: true,
  });
  return { changedLines, isChangedFile: (filename) => changedLines.has(fileKey(filename)) };
}

async function main(args, dependencyScanOptions) {
  if (args[0] === 'deps') return require('./deps/cli.cjs').main(args.slice(1), dependencyScanOptions);
  const { args: sourceArgs, ...baselineOptions } = extractBaselineFlags(args);
  const { values, positionals } = parseSecurityArgs(sourceArgs);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const scope = changedScope(values);
  if ((baselineOptions.baseline || baselineOptions.writeBaseline) && values.fix) {
    throw new Error('--baseline and --write-baseline cannot be combined with --fix.');
  }
  if (baselineOptions.writeBaseline && scope) {
    throw new Error('--write-baseline records every finding; it cannot be combined with --staged or --changed-since.');
  }
  const format = resolveFormat(values);
  if (scope && !scope.changedLines.size && !values.online && ['text', 'json'].includes(format)) {
    console.log(format === 'json' ? '{"scannedFiles":0,"findings":[]}' : 'No changed JavaScript or TypeScript files.');
    return 0;
  }
  const {
    sourcePolicy,
    workspaceTarget,
    projectDirectory,
    scanFilter,
    relativeToCwd,
  } = require('../performance/cli.cjs');
  const workspace = workspaceTarget(values, positionals);
  const project = workspace ? relativeToCwd(workspace.directory) : values.project;
  const directory = workspace?.directory ?? projectDirectory(values.project, positionals);
  values.settings = loadSettings({ directory, explicit: values['loadwise-config'] });
  const policy = sourcePolicy(values.policy, directory, values.settings).read();
  require('node:module').enableCompileCache?.();
  const result = require('../performance/projects.cjs').analyzeSources({
    project: workspace?.configs ?? values.project,
    files: positionals,
    policy,
    onlyFiles: scanFilter(values.settings, scope),
    analyzers: [analyzer],
  });
  if (workspace) result.packages = workspace.packages;
  if (values.online) {
    const dependencies = await require('./deps/scan.cjs').scanDependencies(directory, dependencyScanOptions);
    result.findings.push(...dependencies.findings);
    result.scannedFiles += dependencies.scannedFiles;
    result.scannedPackages = dependencies.scannedPackages;
  } else if (!scope) require('./deps/cli.cjs').noteOffline(directory);
  result.findings.push(...fileFindings(values, positionals, workspace));
  const report = require('../shared/source-report.cjs');
  if (values.fix) {
    report.assignFindingIds(result.findings, report.findingRoot(project));
    // Named ids are explicit, so they reach contextual and ignored findings too.
    if (values.onlyIds.length) {
      return require('../performance/fix-cli.cjs').applyChosenFixes(result.findings, values.onlyIds, {
        json: format === 'json',
      });
    }
    const findings = report.selectFindings(result, values);
    const applicable = values.yes
      ? findings.filter(({ ruleId }) => ruleId !== 'nest-validation-without-whitelist')
      : findings;
    return require('../performance/fix-cli.cjs').applyFixes(applicable, { all: values.yes });
  }
  const fixCommand = report.fixAllCommand('sec', project, positionals, values.workspace);
  return report.printResult(
    result,
    { ...values, project, projectDirectory: directory, baselineOptions, fixCommand, changedLines: scope?.changedLines },
    pillar,
  );
}

module.exports = { main, analyzer, fileFindings, pillar, usage };
