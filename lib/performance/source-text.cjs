'use strict';

const { baselineNoteLines } = require('../shared/baseline.cjs');

// One titled group per monorepo package that has findings; the innermost package owns a nested folder's files.
// A single package or a plain project prints one untitled group.
function findingGroups({ findings, packages }) {
  if (!packages) return [[undefined, findings]];
  const owners = [...packages].sort((left, right) => right.directory.length - left.directory.length);
  const groups = new Map(
    packages.map(({ name, directory }) => [directory, { title: `${name} (${directory})`, findings: [] }]),
  );
  const unowned = { title: 'other files', findings: [] };
  for (const finding of findings) {
    const owner = owners.find(({ directory }) => directory === '.' || finding.file.startsWith(directory + '/'));
    (owner ? groups.get(owner.directory) : unowned).findings.push(finding);
  }
  return [...groups.values(), unowned]
    .filter((group) => group.findings.length)
    .map((group) => [group.title, group.findings]);
}

function printFinding(finding, fixCommand, print) {
  const { findingDetailLines, findingLabel } = require('./finding-text.cjs');
  const { file, line, column, message, contextualReason } = finding;
  print(
    `${file}:${line}:${column} ${findingLabel(finding)} ${finding.impactLevel}: ${message}${contextualReason ? ' (' + contextualReason + ')' : ''}`,
  );
  for (const detail of findingDetailLines(finding)) print(detail);
  if (finding.fix?.requiresReview && fixCommand) {
    print(`  After individual review: ${fixCommand} --fix --only ${finding.id}`);
  }
}

function printFullReport(result, values, baseline, print) {
  for (const [title, findings] of findingGroups(result)) {
    if (title) print(`-- ${title} --`);
    for (const finding of findings) printFinding(finding, values.fixCommand, print);
  }
  const summary = `${result.scannedFiles} file(s) checked, ${result.findings.length} finding(s)`;
  print(
    values['fail-on'] === 'contract'
      ? `${summary}, ${result.contractFindingCount} enforced by --fail-on contract.`
      : summary + '.',
  );
  if (result.contextualFindingCount && !values['include-contextual']) {
    print(`${result.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
  }
  if (baseline) for (const line of baselineNoteLines(baseline)) print(line);
  const fixableIds = result.findings
    .filter((finding) => finding.fixable && !finding.fix?.requiresReview)
    .map((finding) => finding.id);
  if (values.fixCommand && fixableIds.length) {
    print(`Fix all: ${values.fixCommand} --fix --only ${fixableIds.join(',')}`);
  }
}

// Terse form for commits: where it is, what it says, then the exact command to fix or dismiss it.
function printChangedFindings(findings, fixCommand, print) {
  const { findingLabel } = require('./finding-text.cjs');
  for (const finding of findings) {
    print(`${finding.file}:${finding.line} ${findingLabel(finding)} ${finding.impactLevel}: ${finding.message}`);
    if (finding.fixable) print(`  fix:     ${fixCommand} --fix --only ${finding.id}`);
    print(`  dismiss: // loadwise-reviewed ${finding.ruleId} -- <reason>`);
  }
  const fixableIds = findings
    .filter((finding) => finding.fixable && !finding.fix?.requiresReview)
    .map((finding) => finding.id);
  if (fixableIds.length > 1) print(`Fix all: ${fixCommand} --fix --only ${fixableIds.join(',')}`);
  print(
    findings.length
      ? `${findings.length} new finding(s) in changed lines. Apply fixes, then \`git add\` the files and commit again.`
      : 'No new findings in changed lines.',
  );
}

module.exports = { printFullReport, printChangedFindings };
