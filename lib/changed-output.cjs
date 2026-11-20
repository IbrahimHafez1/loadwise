'use strict';

// Text report for changed-lines mode (also what the git hook prints): one finding, then the exact command to act on it.
const toolName = 'maintainability-check';
// Declared contracts cannot be dismissed with a review comment.
const undismissableRules = new Set([
  'file-placement',
  'folder-boundary',
  'data-access-boundary',
  'query-mutates-state',
]);

function printChangedFindings(findings) {
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line} [${finding.ruleId} #${finding.id}] ${finding.message}`);
    if (finding.fix) console.log(`  fix:     npx ${toolName} --fix --only ${finding.id}`);
    if (!undismissableRules.has(finding.ruleId))
      console.log(`  dismiss: // maintainability-reviewed ${finding.ruleId} -- <reason>`);
  }
  if (findings.length) {
    console.log(
      `${findings.length} new finding(s) in changed lines. Apply fixes, then \`git add\` the files and commit again.`,
    );
  }
}

module.exports = { printChangedFindings };
