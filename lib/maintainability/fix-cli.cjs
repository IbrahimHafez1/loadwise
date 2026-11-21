'use strict';

// `--fix`: shows each available site fix as a diff and applies the ones the user accepts.
const fs = require('node:fs');
const path = require('node:path');
const { askChoice } = require('../shared/fix-terminal.cjs');
const { applyFix } = require('./apply-fix.cjs');
const { diffLines } = require('./fix-text.cjs');

const byteOrderMark = '\uFEFF';

// Fix changes name project-relative files. A byte order mark is kept out of the matched text and written back.
function projectFiles(root) {
  const marked = new Set();
  return {
    readFile(file) {
      const text = fs.readFileSync(path.resolve(root, file), 'utf8');
      if (!text.startsWith(byteOrderMark)) return text;
      marked.add(file);
      return text.slice(1);
    },
    writeFile(file, text) {
      fs.writeFileSync(path.resolve(root, file), (marked.has(file) ? byteOrderMark : '') + text);
    },
  };
}

function printFix(finding, index, total) {
  console.log(`\n[${index}/${total}] ${finding.file}:${finding.line}:${finding.column} [${finding.ruleId}]`);
  console.log('  ' + finding.message);
  for (const change of finding.fix.changes) {
    console.log(`  ${change.file}:${change.line}`);
    for (const line of diffLines(change.before, change.after)) console.log(line);
  }
  if (finding.fix.note) console.log('  Note: ' + finding.fix.note);
}

const alreadyAppliedSuffix = 'already applied';

function applyFinding(finding, root, files, capture) {
  if (!finding.fix.changes.some((change) => change.create)) return applyFix(finding.fix, files, capture);
  // An extraction must publish the new module and rewrite its consumers together.
  try {
    require('../shared/fix.cjs').applyBulkFixes([finding], root, { includeReview: true });
    if (capture) finding.fix.changes.forEach(capture);
    return {};
  } catch (error) {
    return { error: error.message };
  }
}

// `--fix --only`: applies exactly the named fixes without asking. An id whose change an earlier id in the same run
// already made counts as done; any other id that cannot be applied is a failure.
function applyChosenFixes(findings, ids, root, { json = false } = {}) {
  const history = require('../shared/fix-history.cjs').checkerHistory(root, root, 'maint');
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const files = projectFiles(root);
  const applied = [];
  const alreadyApplied = [];
  const failed = [];
  for (const [index, id] of ids.entries()) {
    const finding = findingsById.get(id);
    if (finding?.fix && !json) printFix(finding, index + 1, ids.length);
    const error = !finding
      ? 'unknown id'
      : !finding.fix
        ? 'no automatic fix; this finding needs a manual change'
        : applyFinding(finding, root, files, history?.begin()).error;
    if (!error) {
      applied.push(id);
      history?.accept(finding);
    } else if (error.endsWith(alreadyAppliedSuffix)) alreadyApplied.push(id);
    else failed.push({ id, reason: error });
    if (json) continue;
    if (!error) console.log('  Applied.');
    else if (error.endsWith(alreadyAppliedSuffix)) console.log(`  ${id}: already applied by an earlier fix.`);
    else console.log(`  ${id}: not applied, ${error}.`);
  }
  history?.finish(alreadyApplied, failed);
  if (json) console.log(JSON.stringify({ applied, alreadyApplied, failed }, null, 2));
  else {
    console.log(`
Applied ${applied.length} of ${ids.length} chosen fix(es).`);
    if (applied.length) console.log('Review the changes and run your tests; rerun the check to confirm.');
  }
  return failed.length ? 2 : 0;
}

// Findings must already carry their site fixes. Several fixes can touch one function; a later fix whose lines an
// earlier one changed is skipped as stale and reappears, rebuilt, on the next run.
async function applyFixes(findings, root, { all = false } = {}) {
  if (!all && !process.stdin.isTTY)
    throw new Error('--fix asks before each change; use --fix --yes without a terminal.');
  const history = require('../shared/fix-history.cjs').checkerHistory(root, root, 'maint');
  const fixable = findings.filter((finding) => finding.fix && (!all || !finding.fix.requiresReview));
  const files = projectFiles(root);
  let applyRest = all;
  let applied = 0;
  const alreadyApplied = [];
  const failed = [];
  for (const [index, finding] of fixable.entries()) {
    printFix(finding, index + 1, fixable.length);
    if (!applyRest || finding.fix.requiresReview) {
      const choice = await askChoice('  Apply this fix? [y]es / [n]o / [a]ll remaining / [q]uit: ');
      if (choice === 'q') break;
      if (choice === 'n') continue;
      if (choice === 'a') applyRest = true;
    }
    const result = applyFinding(finding, root, files, history?.begin());
    if (result.error?.endsWith(alreadyAppliedSuffix)) {
      alreadyApplied.push(finding.id);
      console.log('  Already applied by an earlier fix.');
    } else if (result.error) {
      failed.push({ id: finding.id, reason: result.error });
      console.log('  Skipped: ' + result.error + '.');
    } else {
      applied++;
      history?.accept(finding);
      console.log('  Applied.');
    }
  }
  history?.finish(alreadyApplied, failed, findings);
  const review = all ? findings.filter((finding) => finding.fix?.requiresReview).length : 0;
  const manual = findings.length - fixable.length - review;
  console.log(
    `\nApplied ${applied} of ${fixable.length} automatic fix(es)` +
      (alreadyApplied.length ? `, ${alreadyApplied.length} already applied` : '') +
      (failed.length ? `, ${failed.length} could not be applied` : '') +
      (review ? `; ${review} fix(es) require individual review` : '') +
      (manual ? `; ${manual} finding(s) need a manual change.` : '.'),
  );
  if (applied) console.log('Review the changes and run your tests; rerun the check to confirm.');
  if (failed.length) console.log('Run the same scan again to generate fixes against the current files.');
  return failed.length ? 2 : 0;
}

module.exports = { applyFixes, applyChosenFixes };
