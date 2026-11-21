'use strict';

// The report of a source checker (perf or sec): finding ids, contextual selection, changed-line filtering, site
// fixes and examples, then text or JSON output and the exit code. `pillar` is { command, contractRules }: the
// loadwise subcommand printed in fix commands and the rule ids that `--fail-on contract` enforces.
const path = require('node:path');

// Ids hash paths relative to the project root, so they match whichever folder the check runs from.
function findingRoot(project) {
  return require('../performance/schema/context.cjs').findProjectRoot(path.resolve(project ?? '.'));
}

function assignFindingIds(findings, root) {
  require('../performance/finding-ids.cjs').assignFindingIds(findings, root);
}

function selectFindings(result, values) {
  result.findings = result.findings.filter((finding) => !values.ignore.includes(finding.ruleId));
  if (values['include-contextual'] !== undefined) {
    const classifyTestWrite = require('../performance/review-context.cjs').createTestWriteClassifier();
    let contextualCount = 0;
    result.findings = result.findings.filter((finding) => {
      const reason = finding.contextualReason || classifyTestWrite(finding.file, finding.ruleId);
      if (!reason) return true;
      finding.contextualReason = reason;
      contextualCount++;
      return values['include-contextual'];
    });
    if (contextualCount) result.contextualFindingCount = contextualCount;
  }
  return result.findings;
}

// `print` receives each output line; the shared perf and sec run collects them per pillar.
function printResult(result, values, pillar, print = console.log) {
  // Ids are assigned before filtering, so collision suffixes do not depend on which findings are shown.
  assignFindingIds(result.findings, findingRoot(values.project));
  selectFindings(result, values);
  if (values.changedLines) {
    result.findings = require('../performance/changed-lines.cjs').keepChangedFindings(
      result.findings,
      values.changedLines,
    );
  }
  const contractOnly = values['fail-on'] === 'contract';
  if (contractOnly) {
    result.contractFindingCount = result.findings.filter(({ ruleId }) => pillar.contractRules.has(ruleId)).length;
  }
  const { attachExample, findingDetailLines, findingLabel } = require('../performance/finding-text.cjs');
  require('../performance/site-fix.cjs').attachSiteFixes(result.findings);
  for (const finding of result.findings) {
    finding.fixable = Boolean(finding.fix);
    attachExample(finding);
  }
  if (values.json) print(JSON.stringify(result, null, values.watch ? 0 : 2));
  else if (values.changedLines) printChangedFindings(result.findings, pillar, print);
  else {
    for (const finding of result.findings) {
      const { file, line, column, message, contextualReason } = finding;
      print(
        `${file}:${line}:${column} ${findingLabel(finding)} ${message}${contextualReason ? ' (' + contextualReason + ')' : ''}`,
      );
      for (const detail of findingDetailLines(finding)) print(detail);
    }
    const summary = `${result.scannedFiles} file(s) checked, ${result.findings.length} finding(s)`;
    print(contractOnly ? `${summary}, ${result.contractFindingCount} enforced by --fail-on contract.` : summary + '.');
    if (result.contextualFindingCount && !values['include-contextual']) {
      print(`${result.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
    }
    const fixableIds = result.findings.filter((finding) => finding.fixable).map((finding) => finding.id);
    if (values.fixCommand && fixableIds.length) {
      print(`Fix all: ${values.fixCommand} --fix --only ${fixableIds.join(',')}`);
    }
  }
  return (contractOnly ? result.contractFindingCount : result.findings.length) ? 1 : 0;
}

// Terse form for commits: where it is, what it says, then the exact command to fix or dismiss it.
function printChangedFindings(findings, pillar, print) {
  const { findingLabel } = require('../performance/finding-text.cjs');
  for (const finding of findings) {
    print(`${finding.file}:${finding.line} ${findingLabel(finding)} ${finding.message}`);
    if (finding.fixable) print(`  fix:     npx loadwise ${pillar.command} --fix --only ${finding.id}`);
    print(`  dismiss: // loadwise-reviewed ${finding.ruleId} -- <reason>`);
  }
  const fixableIds = findings.filter((finding) => finding.fixable).map((finding) => finding.id);
  if (fixableIds.length > 1) print(`Fix all: npx loadwise ${pillar.command} --fix --only ${fixableIds.join(',')}`);
  print(
    findings.length
      ? `${findings.length} new finding(s) in changed lines. Apply fixes, then \`git add\` the files and commit again.`
      : 'No new findings in changed lines.',
  );
}

// The same inputs make `--fix --only` rescan what was reported, so the ids it is given still match.
function fixAllCommand(command, project, files) {
  const inputs = project === undefined ? files : ['-p', project];
  return [`npx loadwise ${command}`, ...inputs.map(quoteArgument)].join(' ');
}

function quoteArgument(argument) {
  return /[\s"'$`\\]/.test(argument) ? JSON.stringify(argument) : argument;
}

module.exports = { findingRoot, assignFindingIds, selectFindings, printResult, fixAllCommand };
