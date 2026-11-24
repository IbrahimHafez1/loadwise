// Text report for changed-lines mode (also what the git hook prints): one finding, then the exact
// command to act on it.
import { supportsReviewDirective } from './review-directive.cjs';
import type { Finding } from '../shared/types.cjs';

function printChangedFindings(findings: Finding[], fixCommand: string): void {
  for (const finding of findings) {
    console.log(
      `${finding.file}:${finding.line} [${finding.ruleId} #${finding.id}] ${finding.impactLevel}: ${finding.message}`,
    );
    if (finding.fix) console.log(`  fix:     ${fixCommand} --fix --only ${finding.id}`);
    if (supportsReviewDirective(finding)) console.log(`  dismiss: // loadwise-reviewed ${finding.ruleId} -- <reason>`);
  }
  const fixableIds = findings
    .filter((finding: Finding) => finding.fix && !finding.fix.requiresReview)
    .map((finding: Finding) => finding.id);
  if (fixableIds.length > 1) console.log(`Fix all: ${fixCommand} --fix --only ${fixableIds.join(',')}`);
  if (findings.length) {
    console.log(
      `${findings.length} new finding(s) in changed lines. Apply fixes, then \`git add\` the files and commit again.`,
    );
  }
}

export { printChangedFindings };
