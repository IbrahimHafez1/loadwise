'use strict';

const fs = require('node:fs');
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
const help = `Usage:
  loadwise maint [directory] [--config policy.json] [--loadwise-config loadwise.config.json] [--ignore rule-id] [--json] [--include-contextual] [--fail-on contract|all] [--min-impact low|medium|high|critical]
  loadwise maint [directory] [--config policy.json] [--include-contextual] --fix [--yes | --only id,...]
  loadwise maint agent init [--mode ask|auto] [--hook [block|warn|off]]
  loadwise maint [directory] (--staged | --changed-since <git-ref>) [--json] [--fix --only id,...]
  loadwise maint [directory] --graph modules.json [--config policy.json] [--json]

A loadwise.config.json in the directory also applies: its "maintainability" section replaces maintainability.config.json (--config still wins), and its ignore, rules and overrides filter the findings; --loadwise-config names another file. --ignore drops a rule's findings.
The default directory is the current folder. Source mode discovers supported files.
Graph mode accepts project-relative files and dependency edges from any language.
Findings with a safe rewrite carry it as a diff, and as "fix" in --json output.
--fix shows each available code fix and asks before applying it; --fix --yes applies every one without asking.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
Every finding has a stable id (shown as #id); a failed --only id exits 2.
Changed-lines mode: --staged reports only findings on lines added or changed in the git index; --changed-since <git-ref> does the same against that ref.
Only changed files are analysed there (duplicate-implementation and cycles through unchanged files are skipped unless many files changed, which runs the full scan), and --fail-on defaults to all.
agent init writes one block of instructions for AI coding agents, covering both checkers, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
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
function fixAllCommand(directory, config) {
  const inputs = [
    ...(directory === undefined ? [] : [directory]),
    ...(config === undefined ? [] : ['--config', config]),
  ];
  return ['npx loadwise maint', ...inputs.map(quoteArgument)].join(' ');
}

function quoteArgument(argument) {
  return /[\s"'$`\\]/.test(argument) ? JSON.stringify(argument) : argument;
}

// Changed-lines mode reads git before anything heavy loads, so a commit with no JS/TS changes costs almost nothing.
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

async function main(args) {
  if (args[0] === 'agent') return require('../shared/agent-init.cjs').runAgentCommand(args.slice(1));
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
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
    },
  });
  const onlyIds = values.only
    .flatMap((list) => list.split(','))
    .map((id) => id.trim())
    .filter(Boolean);
  if (values.help) {
    console.log(help);
    return 0;
  }
  const changedMode = Boolean(values.staged) || values['changed-since'] !== undefined;
  // A hook should stop on any new finding it reports, not only on declared contracts.
  const failOn = values['fail-on'] ?? (changedMode ? 'all' : 'contract');
  if (positionals.length > 1 || !['all', 'contract'].includes(failOn)) {
    throw new Error('Pass one directory and --fail-on contract or all.');
  }
  const minImpact = parseMinImpact(values['min-impact']);
  if (values.only.length && !values.fix) throw new Error('--only is only valid with --fix.');
  if (values.only.length && !onlyIds.length) throw new Error('--only needs at least one finding id.');
  if (values.fix && (values.graph !== undefined || (values.json && !onlyIds.length)))
    throw new Error('--fix cannot be combined with --graph, or with --json unless --only is given.');
  if (values.yes && !values.fix) throw new Error('--yes is only valid with --fix.');
  const root = path.resolve(positionals[0] ?? '.');
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Expected a project directory.');
  const changes = readChanges(root, values);
  if (changes && !changes.size) return 0;
  require('node:module').enableCompileCache?.();
  const { loadPolicy, checkImportedGraph } = require('./project.cjs');
  const settings = loadSettings({ directory: root, explicit: values['loadwise-config'], ignore: values.ignore });
  const policy = loadPolicy(root, values.config, settings.maintainability);
  // Ignored files leave file discovery, so duplicates, cycles and boundaries never see them.
  if (settings.isIgnored) policy.isIgnored = (file) => settings.isIgnored(root, file);
  const report = changes
    ? await require('./scan-changed.cjs').scanChangedFiles(root, policy, [...changes.keys()])
    : values.graph !== undefined
      ? checkImportedGraph(values.graph, policy)
      : await require('./scan.cjs').scan(root, policy);
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
  // Named ids are explicit, so they reach contextual findings too.
  if (onlyIds.length) {
    const { attachSiteFixes } = require('./site-fix.cjs');
    attachSiteFixes(
      report.findings.filter((finding) => onlyIds.includes(finding.id)),
      root,
    );
    return require('./fix-cli.cjs').applyChosenFixes(report.findings, onlyIds, root, {
      json: values.json,
    });
  }
  report.findings = sortByImpactWithinFiles(filterMinImpact(annotateImpact(report.findings, impactByRule), minImpact));
  const contracts = new Set(['file-placement', 'folder-boundary', 'data-access-boundary', 'query-mutates-state']);
  report.contractFindingCount = report.findings.filter((finding) => contracts.has(finding.ruleId)).length;
  const contextual = report.findings.filter((finding) => finding.contextualReason && !contracts.has(finding.ruleId));
  if (contextual.length) {
    report.contextualFindingCount = contextual.length;
    if (!values['include-contextual'])
      report.findings = report.findings.filter((finding) => !finding.contextualReason || contracts.has(finding.ruleId));
  }
  if (report.mode === 'source') require('./site-fix.cjs').attachSiteFixes(report.findings, root);
  if (values.fix) return require('./fix-cli.cjs').applyFixes(report.findings, root, { all: values.yes });
  if (changes && !values.json) {
    require('./changed-output.cjs').printChangedFindings(report.findings);
  } else if (values.json) {
    for (const finding of report.findings) {
      addExample(finding);
      finding.fixable = Boolean(finding.fix);
    }
    console.log(JSON.stringify(report, null, 2));
  } else {
    const printedRules = new Set();
    for (const finding of report.findings) {
      console.log(
        `${finding.file}:${finding.line}:${finding.column} [${finding.ruleId} #${finding.id}] ${finding.impactLevel}: ${finding.message}`,
      );
      if (finding.contextualReason) console.log('  ' + finding.contextualReason);
      for (const site of finding.related ?? []) console.log(`  ${site.file}:${site.line}:${site.column}`);
      if (finding.fix) for (const line of fixLines(finding.fix)) console.log(line);
      else printFixOnce(finding.ruleId, printedRules);
    }
    console.log(
      `${report.scannedFiles ?? report.graphFiles} ${report.mode} file(s), ${report.findings.length} finding(s), ${report.contractFindingCount} contract finding(s).`,
    );
    if (contextual.length && !values['include-contextual'])
      console.log(`${contextual.length} contextual finding(s) available with --include-contextual.`);
    const warningNote = settings.warningNote(report.findings);
    if (warningNote) console.log(warningNote);
    if (report.mode === 'source' && policy.boundaries.length && report.dependencyFiles < report.scannedFiles) {
      console.log(
        `Source dependency analysis covered ${report.dependencyFiles} JS/TS files. Use --graph for additional language boundaries.`,
      );
    }
    const fixableIds = report.findings.filter((finding) => finding.fix).map((finding) => finding.id);
    if (report.mode === 'source' && fixableIds.length) {
      console.log(`Fix all: ${fixAllCommand(positionals[0], values.config)} --fix --only ${fixableIds.join(',')}`);
    }
  }
  if (report.mode === 'source' && !changes) require('./notify-editor.cjs').notifyEditor(root);
  const isContract = failOn === 'all' ? undefined : (finding) => contracts.has(finding.ruleId);
  return settings.exitCount(report.findings, isContract) ? 1 : 0;
}

module.exports = { main };
