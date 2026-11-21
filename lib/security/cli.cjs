'use strict';

// `loadwise sec`: flag parsing, policy discovery, the security scan, the report and its exit code.
const path = require('node:path');
const { parseArgs } = require('node:util');
const { securityRules, contractRules } = require('./rule-ids.cjs');

const usage = `Usage:
  loadwise sec [-p tsconfig.json | file.ts file.js ...] [--policy policy.json] [--json] [--include-contextual] [--ignore rule-id] [--fail-on all|contract] [--fix [--yes | --only id,...]]
  loadwise sec deps [--online] [directory] [--format text|json] [--json] [--include-contextual] [--ignore rule-id]
  loadwise sec [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]

With no arguments, check tsconfig.json or jsconfig.json in the current directory.
Security checks read prismaScopes and drizzleScopes from backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
Security checks always use the TypeScript 6 compiler. Rules that need a package's types stay silent until it is installed; rules that recognise libraries by their imports work without node_modules.
--fix shows each available code fix and asks before applying it; --fix --yes applies every one without asking.
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
  if (values.fix && values.json && !values.onlyIds.length)
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

function changedScope(values) {
  if (!values.staged && values['changed-since'] === undefined) return;
  const { collectChangedLines, fileKey } = require('../performance/changed-lines.cjs');
  const changedLines = collectChangedLines({ staged: values.staged, ref: values['changed-since'] });
  return { changedLines, isChangedFile: (filename) => changedLines.has(fileKey(filename)) };
}

// Explicit files and the default project are looked up from the working directory; -p from its folder.
function dependencyScanDirectory(project) {
  return project ? path.dirname(path.resolve(project)) : process.cwd();
}

async function main(args, dependencyScanOptions) {
  if (args[0] === 'deps') return require('./deps/cli.cjs').main(args.slice(1), dependencyScanOptions);
  const { values, positionals } = parseSecurityArgs(args);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const scope = changedScope(values);
  if (scope && !scope.changedLines.size) {
    console.log(values.json ? '{"scannedFiles":0,"findings":[]}' : 'No changed JavaScript or TypeScript files.');
    return 0;
  }
  const path = require('node:path');
  const { loadSettings } = require('../shared/config.cjs');
  const { resolveConfig } = require('../performance/source-inputs.cjs');
  const directory = positionals.length ? process.cwd() : path.dirname(resolveConfig(values.project ?? '.'));
  const policy = require('../performance/cli.cjs')
    .sourcePolicy(values.policy, directory, loadSettings({ directory }))
    .read();
  require('node:module').enableCompileCache?.();
  const result = require('../performance/projects.cjs').analyzeSources({
    project: values.project,
    files: positionals,
    policy,
    onlyFiles: scope?.isChangedFile,
    analyzers: [analyzer],
  });
  const dependencyDirectory = dependencyScanDirectory(values.project);
  if (values.online) {
    const dependencies = await require('./deps/scan.cjs').scanDependencies(dependencyDirectory, dependencyScanOptions);
    result.findings.push(...dependencies.findings);
  } else if (!scope) require('./deps/cli.cjs').noteOffline(dependencyDirectory);
  const report = require('../shared/source-report.cjs');
  if (values.fix) {
    report.assignFindingIds(result.findings, report.findingRoot(values.project));
    // Named ids are explicit, so they reach contextual and ignored findings too.
    if (values.onlyIds.length) {
      return require('../performance/fix-cli.cjs').applyChosenFixes(result.findings, values.onlyIds, {
        json: values.json,
      });
    }
    report.selectFindings(result, values);
    return require('../performance/fix-cli.cjs').applyFixes(result.findings, { all: values.yes });
  }
  const fixCommand = report.fixAllCommand('sec', values.project, positionals);
  return report.printResult(result, { ...values, fixCommand, changedLines: scope?.changedLines }, pillar);
}

module.exports = { main, analyzer, pillar, usage };
