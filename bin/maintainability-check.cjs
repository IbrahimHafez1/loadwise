#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { exampleFor } = require('../lib/examples.cjs');
const help = `Usage:
  maintainability-check [directory] [--config policy.json] [--json] [--include-contextual] [--fail-on contract|all]
  maintainability-check [directory] --graph modules.json [--config policy.json] [--json]

The default directory is the current folder. Source mode discovers supported files.
Graph mode accepts project-relative files and dependency edges from any language.
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

async function main(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      config: { type: 'string' },
      graph: { type: 'string' },
      'include-contextual': { type: 'boolean' },
      'fail-on': { type: 'string', default: 'contract' },
    },
  });
  if (values.help) {
    console.log(help);
    return 0;
  }
  if (positionals.length > 1 || !['all', 'contract'].includes(values['fail-on'])) {
    throw new Error('Pass one directory and --fail-on contract or all.');
  }
  const root = path.resolve(positionals[0] ?? '.');
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Expected a project directory.');
  require('node:module').enableCompileCache?.();
  const { loadPolicy, checkImportedGraph } = require('../lib/project.cjs');
  const policy = loadPolicy(root, values.config);
  const report =
    values.graph !== undefined
      ? checkImportedGraph(values.graph, policy)
      : await require('../lib/scan.cjs').scan(root, policy);
  report.findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
  const contracts = new Set(['file-placement', 'folder-boundary', 'query-mutates-state']);
  report.contractFindingCount = report.findings.filter((finding) => contracts.has(finding.ruleId)).length;
  const contextual = report.findings.filter((finding) => finding.contextualReason && !contracts.has(finding.ruleId));
  if (contextual.length) {
    report.contextualFindingCount = contextual.length;
    if (!values['include-contextual'])
      report.findings = report.findings.filter((finding) => !finding.contextualReason || contracts.has(finding.ruleId));
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    const printedRules = new Set();
    for (const finding of report.findings) {
      console.log(`${finding.file}:${finding.line}:${finding.column} [${finding.ruleId}] ${finding.message}`);
      if (finding.contextualReason) console.log('  ' + finding.contextualReason);
      for (const site of finding.related ?? []) console.log(`  ${site.file}:${site.line}:${site.column}`);
      printFixOnce(finding.ruleId, printedRules);
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
  if (report.mode === 'source') require('../lib/notify-editor.cjs').notifyEditor(root);
  return (values['fail-on'] === 'all' ? report.findings.length : report.contractFindingCount) ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
