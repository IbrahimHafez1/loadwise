'use strict';

// Text report for changed-lines mode (also what the git hook prints): one finding, then the exact command to act on it.
const toolName = 'loadwise maint';
// Declared contracts cannot be dismissed with a review comment.
const undismissableRules = new Set([
  'file-placement',
  'folder-boundary',
  'data-access-boundary',
  'query-mutates-state',
]);

function printChangedFindings(findings) {
  for (const finding of findings) {
    console.log(
      `${finding.file}:${finding.line} [${finding.ruleId} #${finding.id}] ${finding.impactLevel}: ${finding.message}`,
    );
    if (finding.fix) console.log(`  fix:     npx ${toolName} --fix --only ${finding.id}`);
    if (!undismissableRules.has(finding.ruleId))
      console.log(`  dismiss: // loadwise-reviewed ${finding.ruleId} -- <reason>`);
  }
  const fixableIds = findings.filter((finding) => finding.fix).map((finding) => finding.id);
  if (fixableIds.length > 1) console.log(`Fix all: npx ${toolName} --fix --only ${fixableIds.join(',')}`);
  if (findings.length) {
    console.log(
      `${findings.length} new finding(s) in changed lines. Apply fixes, then \`git add\` the files and commit again.`,
    );
  }
}

module.exports = { printChangedFindings };
