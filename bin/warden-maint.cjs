#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { exampleFor } = require('../lib/maintainability/examples.cjs');
const { fixLines } = require('../lib/maintainability/fix-text.cjs');
const help = `Usage:
  warden-maint [directory] [--config policy.json] [--json] [--include-contextual] [--fail-on contract|all]
  warden-maint [directory] [--config policy.json] [--include-contextual] --fix [--yes | --only id,...]
  warden-maint agent init [--mode ask|auto] [--hook block|warn|off]
  warden-maint [directory] (--staged | --changed-since <git-ref>) [--json] [--fix --only id,...]
  warden-maint [directory] --graph modules.json [--config policy.json] [--json]

The default directory is the current folder. Source mode discovers supported files.
Graph mode accepts project-relative files and dependency edges from any language.
Findings with a safe rewrite carry it as a diff, and as "fix" in --json output.
--fix shows each available code fix and asks before applying it; --fix --yes applies every one without asking.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
Every finding has a stable id (shown as #id); a failed --only id exits 2.
Changed-lines mode: --staged reports only findings on lines added or changed in the git index; --changed-since <git-ref> does the same against that ref.
Only changed files are analysed there (duplicate-implementation and cycles through unchanged files are skipped unless many files changed, which runs the full scan), and --fail-on defaults to all.
agent init writes instructions for AI coding agents into AGENTS.md and imports them from CLAUDE.md.
agent init --hook installs a git pre-commit hook that runs --staged: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
Add "// warden-reviewed <rule-id> -- <reason>" on the line above a finding to mark it as reviewed.
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

// `--hook` without a value means warn, which parseArgs cannot express for a string option.
function withDefaultHookMode(args) {
  const index = args.indexOf('--hook');
  if (index === -1 || ['block', 'warn', 'off'].includes(args[index + 1])) return args;
  return [...args.slice(0, index + 1), 'warn', ...args.slice(index + 1)];
}

function initAgentCommand(args) {
  const { values, positionals } = parseArgs({
    args: withDefaultHookMode(args),
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      mode: { type: 'string', default: 'ask' },
      hook: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(help);
    return 0;
  }
  if (positionals.length) throw new Error('agent init accepts only --mode ask|auto and --hook block|warn|off.');
  const { initAgent, findProjectRoot } = require('../lib/maintainability/agent-init.cjs');
  const written = initAgent(process.cwd(), values.mode);
  for (const filename of written) console.log('Wrote ' + filename);
  if (!written.length) console.log('AGENTS.md and CLAUDE.md are already up to date.');
  if (values.hook !== undefined) reportHook(values.hook, findProjectRoot(process.cwd()));
  return 0;
}

function reportHook(mode, projectRoot) {
  const result = require('../lib/maintainability/git-hook.cjs').installHook(projectRoot, mode);
  if (result.action === 'lefthook') {
    console.log('lefthook is configured; add this command to its pre-commit section yourself:\n  ' + result.command);
  } else if (result.action === 'absent') console.log('No warden-maint hook to remove.');
  else console.log(`Hook ${result.action}: ${result.filename}`);
}

// Changed-lines mode reads git before anything heavy loads, so a commit with no JS/TS changes costs almost nothing.
function readChanges(root, values) {
  if (!values.staged && values['changed-since'] === undefined) return undefined;
  if (values.staged && values['changed-since'] !== undefined)
    throw new Error('Pass --staged or --changed-since, not both.');
  if (values.graph !== undefined) throw new Error('--staged and --changed-since cannot be combined with --graph.');
  return require('../lib/maintainability/changed-lines.cjs').readChangedRanges(root, {
    staged: values.staged,
    since: values['changed-since'],
  });
}

async function main(args) {
  if (args[0] === 'agent') {
    if (args[1] !== 'init') throw new Error('Usage: warden-maint agent init [--mode ask|auto] [--hook block|warn|off]');
    return initAgentCommand(args.slice(2));
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      config: { type: 'string' },
      graph: { type: 'string' },
      'include-contextual': { type: 'boolean' },
      'fail-on': { type: 'string' },
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
  const { loadPolicy, checkImportedGraph } = require('../lib/maintainability/project.cjs');
  const policy = loadPolicy(root, values.config);
  const report = changes
    ? await require('../lib/maintainability/scan-changed.cjs').scanChangedFiles(root, policy, [...changes.keys()])
    : values.graph !== undefined
      ? checkImportedGraph(values.graph, policy)
      : await require('../lib/maintainability/scan.cjs').scan(root, policy);
  report.findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
  if (report.mode === 'source')
    require('../lib/maintainability/review-directive.cjs').applyReviewDirectives(report.findings, root);
  require('../lib/maintainability/finding-ids.cjs').assignFindingIds(report.findings, root);
  if (changes)
    report.findings = require('../lib/maintainability/changed-lines.cjs').filterToChangedLines(
      report.findings,
      changes,
    );
  // Named ids are explicit, so they reach contextual findings too.
  if (onlyIds.length) {
    const { attachSiteFixes } = require('../lib/maintainability/site-fix.cjs');
    attachSiteFixes(
      report.findings.filter((finding) => onlyIds.includes(finding.id)),
      root,
    );
    return require('../lib/maintainability/fix-cli.cjs').applyChosenFixes(report.findings, onlyIds, root, {
      json: values.json,
    });
  }
  const contracts = new Set(['file-placement', 'folder-boundary', 'data-access-boundary', 'query-mutates-state']);
  report.contractFindingCount = report.findings.filter((finding) => contracts.has(finding.ruleId)).length;
  const contextual = report.findings.filter((finding) => finding.contextualReason && !contracts.has(finding.ruleId));
  if (contextual.length) {
    report.contextualFindingCount = contextual.length;
    if (!values['include-contextual'])
      report.findings = report.findings.filter((finding) => !finding.contextualReason || contracts.has(finding.ruleId));
  }
  if (report.mode === 'source') require('../lib/maintainability/site-fix.cjs').attachSiteFixes(report.findings, root);
  if (values.fix)
    return require('../lib/maintainability/fix-cli.cjs').applyFixes(report.findings, root, { all: values.yes });
  if (changes && !values.json) {
    require('../lib/maintainability/changed-output.cjs').printChangedFindings(report.findings);
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
        `${finding.file}:${finding.line}:${finding.column} [${finding.ruleId} #${finding.id}] ${finding.message}`,
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
    if (report.mode === 'source' && policy.boundaries.length && report.dependencyFiles < report.scannedFiles) {
      console.log(
        `Source dependency analysis covered ${report.dependencyFiles} JS/TS files. Use --graph for additional language boundaries.`,
      );
    }
  }
  if (report.mode === 'source' && !changes) require('../lib/maintainability/notify-editor.cjs').notifyEditor(root);
  return (failOn === 'all' ? report.findings.length : report.contractFindingCount) ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
