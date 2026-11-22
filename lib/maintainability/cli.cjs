'use strict';

const { isProjectDirectory } = require('../shared/workspaces.cjs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { exampleFor } = require('./examples.cjs');
const { impactByRule } = require('./rule-ids.cjs');
const {
  annotateImpact,
  filterMinImpact,
  parseMinImpact,
  sortByImpactWithinFiles,
} = require('../shared/impact-levels.cjs');
const { fixLines } = require('./fix-text.cjs');
const { loadSettings } = require('../shared/config.cjs');
const {
  applyBaselineOptions,
  baselineForScan,
  baselineNoteLines,
  extractBaselineFlags,
} = require('../shared/baseline.cjs');
const { resolveFormat, renderReports } = require('../shared/formats/index.cjs');
const { fixPresentation, withoutWhyComment } = require('../shared/fix-presentation.cjs');
const { contractRules } = require('../shared/formats/contract-rules.cjs');
const { quoteArgument } = require('../shared/shell-argument.cjs');
const { exitCodeWithSkips } = require('../performance/scan-outcome.cjs');
const help = `Usage:
  loadwise maint [directory] [--config policy.json] [--loadwise-config loadwise.config.json] [--workspace name|path ...] [--ignore rule-id] [--json | --format text|json|sarif|github] [--include-contextual] [--fail-on contract|all] [--min-impact low|medium|high|critical] [--baseline [file] | --write-baseline [file]]
  loadwise maint [directory] [--config policy.json] [--include-contextual] --fix [--yes | --only id,...] [--comments] [--no-format]
  loadwise maint agent init [--mode ask|auto] [--hook [block|warn|off]]
  loadwise maint [directory] (--staged | --changed-since <git-ref>) [--json] [--fix --only id,...]
  loadwise maint [directory] --graph modules.json [--config policy.json] [--json]

A loadwise.config.json in the directory also applies: its "maintainability" section replaces maintainability.config.json (--config still wins), and its ignore, rules and overrides filter the findings; --loadwise-config names another file. --ignore drops a rule's findings.
The default directory is the current folder. Source mode discovers supported files.
Graph mode accepts project-relative files and dependency edges from any language.
Findings with a safe rewrite carry it as a diff, and as "fix" in --json output.
--fix shows each available code fix and asks before applying it; --fix --yes applies every one without asking.
If a selected fix can no longer be applied, the command exits 2. Rerun the scan to refresh the fixes.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
--fix formats the changed lines with the project's Prettier (--no-format turns this off); --comments also adds a "// Loadwise <rule-id>: <why>" comment above each fixed statement.
Every finding has a stable id (shown as #id); a failed --only id exits 2.
Changed-lines mode: --staged reports only findings on lines added or changed in the git index; --changed-since <git-ref> does the same against that ref.
Only changed files are analysed there (duplicate-implementation and cycles through unchanged files are skipped unless many files changed, which runs the full scan), and --fail-on defaults to all.
agent init writes one block of instructions for AI coding agents, covering all three checkers, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
--write-baseline records the current findings in loadwise-baseline.json at the project root (or the given file); --baseline hides them so only new findings are reported and reports how many were hidden.
The baseline file has one section per checker, shared with loadwise perf and loadwise check; entries are matched by rule, file and flagged code, not line number.
Add "// loadwise-reviewed <rule-id> -- <reason>" on the line above a finding to mark it as reviewed.
--min-impact reports only findings at that impact level or above; the rest do not count toward the exit code.
By default, only declared folder or query contracts fail CI. Exit codes are 0, 1 (threshold met), 2 (invalid input).`;

// Prints each rule's example once so output stays short when many findings share a rule.
function printFixOnce(ruleId, printedRules) {
  const example = exampleFor(ruleId);
  if (!example || printedRules.has(ruleId)) return;
  printedRules.add(ruleId);
  console.log('  Fix:');
  for (const line of example.before) console.log('    - ' + line);
  for (const line of example.after) console.log('    + ' + line);
}

// Additive field: existing consumers ignore it.
function addExample(finding) {
  const example = exampleFor(finding.ruleId);
  if (example) finding.example = example;
}

// The same directory and policy make `--fix --only` rescan what was reported, so the ids it is given still match.
function fixAllCommand(directory, values) {
  const inputs = [
    ...(directory && directory !== '.' ? [directory] : []),
    ...(values.config === undefined ? [] : ['--config', values.config]),
    ...(values['loadwise-config'] === undefined ? [] : ['--loadwise-config', values['loadwise-config']]),
    ...values.workspace.flatMap((workspace) => ['--workspace', workspace]),
    ...values.ignore.flatMap((rule) => ['--ignore', rule]),
    ...(values.staged ? ['--staged'] : []),
    ...(values['changed-since'] === undefined ? [] : ['--changed-since', values['changed-since']]),
  ];
  return ['npx loadwise maint', ...inputs.map(quoteArgument)].join(' ');
}

// Read git before loading TypeScript when no supported source changed.
function readChanges(root, values) {
  if (!values.staged && values['changed-since'] === undefined) return undefined;
  if (values.staged && values['changed-since'] !== undefined)
    throw new Error('Pass --staged or --changed-since, not both.');
  if (values.graph !== undefined) throw new Error('--staged and --changed-since cannot be combined with --graph.');
  return require('./changed-lines.cjs').readChangedRanges(root, {
    staged: values.staged,
    since: values['changed-since'],
  });
}

// Folders of the --workspace packages, relative to the scanned root, or undefined when no package was chosen.
function selectedWorkspaceFolders(root, selectors) {
  if (!selectors.length) return undefined;
  const { discoverWorkspaces, selectWorkspaces } = require('../shared/workspaces.cjs');
  const { packages, withoutConfig } = discoverWorkspaces(root);
  const chosen = selectWorkspaces([...packages, ...withoutConfig], root, selectors);
  return chosen.map(({ directory }) => path.relative(root, directory).split(path.sep).join('/'));
}

function parseScanOptions(args) {
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
    .flatMap((list) => list.split(','))
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

function reportEmptyChanges(root, format, onlyIds) {
  if (onlyIds.length) return require('./fix-cli.cjs').applyChosenFixes([], onlyIds, root, { json: format === 'json' });
  const report = { mode: 'source', scannedFiles: 0, findings: [], contractFindingCount: 0 };
  if (format === 'json') console.log(JSON.stringify(report));
  if (format === 'sarif') console.log(renderReports(format, [{ pillar: 'maintainability', root, report }]));
  return 0;
}

async function scanProject(root, values, { changes, inScope }) {
  require('node:module').enableCompileCache?.();
  const { loadPolicy, checkImportedGraph } = require('./project.cjs');
  const settings = loadSettings({ directory: root, explicit: values['loadwise-config'], ignore: values.ignore });
  const policy = loadPolicy(root, values.config, settings.maintainability);
  // Ignored files leave file discovery, so duplicates, cycles and boundaries never see them.
  if (settings.isIgnored) policy.isIgnored = (file) => settings.isIgnored(root, file);
  const { ignoredAllSources, identifierIndex, ...report } = changes
    ? await require('./scan-changed.cjs').scanChangedFiles(root, policy, [...changes.keys()], { inScope })
    : values.graph !== undefined
      ? checkImportedGraph(values.graph, policy)
      : await require('./scan.cjs').scan(root, policy, { inScope, indexIdentifiers: true });
  if (ignoredAllSources && !changes) {
    console.error(`Note: every source file matches "ignore" in ${settings.filename}; no files were left to check.`);
  }
  if (inScope) report.findings = report.findings.filter((finding) => inScope(finding.file));
  report.findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
  if (report.mode === 'source') require('./review-directive.cjs').applyReviewDirectives(report.findings, root);
  require('./finding-ids.cjs').assignFindingIds(report.findings, root);
  // Ids are assigned first, so collision suffixes do not depend on which findings the config drops.
  report.findings = settings.apply(report.findings, root);
  if (changes) report.findings = require('./changed-lines.cjs').filterToChangedLines(report.findings, changes);
  return { report, policy, settings, identifierIndex };
}

function filterAdvisories(report, minImpact, includeContextual) {
  report.findings = sortByImpactWithinFiles(filterMinImpact(annotateImpact(report.findings, impactByRule), minImpact));
  const contracts = contractRules.maintainability;
  const contextual = report.findings.filter((finding) => finding.contextualReason && !contracts.has(finding.ruleId));
  if (contextual.length) {
    report.contextualFindingCount = contextual.length;
    if (!includeContextual)
      report.findings = report.findings.filter((finding) => !finding.contextualReason || contracts.has(finding.ruleId));
  }
}

function processBaseline(report, { baselineOptions, root, values, format }) {
  const baseline = applyBaselineOptions({
    // A --graph scan covers the graph, not the folder, so only a folder scan limits the baseline to it.
    options: baselineForScan(baselineOptions, values, values.graph === undefined ? [root] : []),
    pillar: 'maintainability',
    findings: report.findings,
    projectRoot: root,
    absoluteFileOf: (finding) => path.resolve(root, finding.file),
    idRoot: root,
  });
  if (baseline?.written !== undefined) {
    const message = `Wrote ${baseline.written} finding(s) to ${path.relative(process.cwd(), baseline.file) || baseline.file}.`;
    (format === 'text' ? console.log : console.error)(message);
    return baseline;
  }
  if (baseline) {
    report.findings = baseline.findings;
    report.baselineHidden = baseline.hidden;
    report.baselineStale = baseline.stale;
  }
  report.contractFindingCount = report.findings.filter((finding) =>
    contractRules.maintainability.has(finding.ruleId),
  ).length;
  return baseline;
}

function printStructuredReport(report, format, root) {
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

function printFinding(finding, printedRules, fixCommand) {
  console.log(
    `${finding.file}:${finding.line}:${finding.column} [${finding.ruleId} #${finding.id}] ${finding.impactLevel}: ${finding.message}`,
  );
  if (finding.contextualReason) console.log('  ' + finding.contextualReason);
  for (const site of finding.related ?? []) console.log(`  ${site.file}:${site.line}:${site.column}`);
  if (finding.fix) for (const line of fixLines(withoutWhyComment(finding.fix, finding.ruleId))) console.log(line);
  else printFixOnce(finding.ruleId, printedRules);
  if (finding.fix?.requiresReview) {
    console.log(`  After individual review: ${fixCommand} --fix --only ${finding.id}`);
  }
}

// The shared reason once, then each location with its own details one level further in.
function printFindingGroup(group, printedRules, fixCommand) {
  const [first] = group;
  const context = first.contextualReason ? ` (${first.contextualReason})` : '';
  console.log(`[${first.ruleId}] ${first.impactLevel}: ${first.message}${context} (${group.length} findings)`);
  for (const finding of group) {
    console.log(`  ${finding.file}:${finding.line}:${finding.column} #${finding.id}`);
    for (const site of finding.related ?? []) console.log(`    ${site.file}:${site.line}:${site.column}`);
    if (finding.fix)
      for (const line of fixLines(withoutWhyComment(finding.fix, finding.ruleId))) console.log('  ' + line);
    if (finding.fix?.requiresReview) {
      console.log(`    After individual review: ${fixCommand} --fix --only ${finding.id}`);
    }
  }
  if (group.some((finding) => !finding.fix)) printFixOnce(first.ruleId, printedRules);
}

function printTextReport(report, { directory, values, baseline, settings, policy }) {
  const printedRules = new Set();
  const fixCommand = fixAllCommand(directory, values);
  const { findingReason, groupByReason } = require('../shared/reason-groups.cjs');
  for (const group of groupByReason(report.findings, findingReason)) {
    if (group.length === 1) printFinding(group[0], printedRules, fixCommand);
    else printFindingGroup(group, printedRules, fixCommand);
  }
  console.log(
    `${report.scannedFiles ?? report.graphFiles} ${report.mode} file(s), ${report.findings.length} finding(s), ${report.contractFindingCount} contract finding(s).`,
  );
  if (report.contextualFindingCount && !values['include-contextual'])
    console.log(`${report.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
  const warningNote = settings.warningNote(report.findings);
  if (warningNote) console.log(warningNote);
  if (baseline) for (const line of baselineNoteLines(baseline)) console.log(line);
  if (report.mode === 'source' && policy.boundaries.length && report.dependencyFiles < report.scannedFiles) {
    console.log(
      `Source dependency analysis covered ${report.dependencyFiles} JS/TS files. Use --graph for additional language boundaries.`,
    );
  }
  const fixableIds = report.findings
    .filter((finding) => finding.fix && !finding.fix.requiresReview)
    .map((finding) => finding.id);
  if (report.mode === 'source' && fixableIds.length) {
    console.log(`Fix all: ${fixCommand} --fix --only ${fixableIds.join(',')}`);
  }
}

function printScanReport(report, options) {
  const { root, format, directory, values, baseline, changes } = options;
  if (format !== 'text') printStructuredReport(report, format, root);
  else if (changes) {
    require('./changed-output.cjs').printChangedFindings(report.findings, fixAllCommand(directory, values));
    if (baseline) for (const line of baselineNoteLines(baseline)) console.log(line);
  } else printTextReport(report, options);
}

async function main(args) {
  if (args[0] === 'agent') return require('../shared/agent-init.cjs').runAgentCommand(args.slice(1));
  const {
    help: showHelp,
    values,
    directory,
    format,
    minImpact,
    failOn,
    baselineOptions,
    onlyIds,
  } = parseScanOptions(args);
  if (showHelp) {
    console.log(help);
    return 0;
  }
  const root = path.resolve(directory ?? '.');
  if (!(await isProjectDirectory(root))) throw new Error('Expected a project directory.');
  const workspaceFolders = selectedWorkspaceFolders(root, values.workspace);
  const inScope = workspaceFolders && ((file) => workspaceFolders.some((folder) => file.startsWith(folder + '/')));
  const changes = readChanges(root, values);
  if (changes && !changes.size) return reportEmptyChanges(root, format, onlyIds);
  const { report, policy, settings, identifierIndex } = await scanProject(root, values, { changes, inScope });
  // Named ids are explicit, so they reach contextual findings too.
  if (onlyIds.length) {
    const { attachSiteFixes } = require('./site-fix.cjs');
    attachSiteFixes(
      report.findings.filter((finding) => onlyIds.includes(finding.id)),
      root,
      { identifierIndex },
    );
    return exitCodeWithSkips(
      report,
      await require('./fix-cli.cjs').applyChosenFixes(report.findings, onlyIds, root, {
        json: format === 'json',
        ...fixPresentation(values),
      }),
    );
  }
  filterAdvisories(report, minImpact, values['include-contextual']);
  const baseline = processBaseline(report, { baselineOptions, root, values, format });
  if (baseline?.written !== undefined) return exitCodeWithSkips(report, 0);
  if (report.mode === 'source') require('./site-fix.cjs').attachSiteFixes(report.findings, root, { identifierIndex });
  if (values.fix) {
    const fixCode = await require('./fix-cli.cjs').applyFixes(report.findings, root, {
      all: values.yes,
      ...fixPresentation(values),
    });
    return exitCodeWithSkips(report, fixCode);
  }
  printScanReport(report, { root, format, directory, values, baseline, settings, policy, changes });
  if (report.mode === 'source' && !changes) require('./notify-editor.cjs').notifyEditor(root);
  const isContract = failOn === 'all' ? undefined : (finding) => contractRules.maintainability.has(finding.ruleId);
  return exitCodeWithSkips(report, settings.exitCount(report.findings, isContract) ? 1 : 0);
}

module.exports = { main };
