'use strict';

// `--fix`: shows each available site fix as a diff and applies the ones the user accepts.
const fs = require('node:fs');
const path = require('node:path');
const { askChoice } = require('../shared/fix-terminal.cjs');
const { applyFix } = require('../../editor/apply-fix.cjs');
const { diffLines, findingLabel } = require('./finding-text.cjs');
const { applyFixSafely } = require('../shared/fix-safety.cjs');
const { createWriteTracker, withoutWhyComment } = require('../shared/fix-presentation.cjs');

// applyFix's error when every change of a fix is already in the file.
const alreadyAppliedError = 'already applied';

const fileAccess = {
  readFile: (file) => fs.readFileSync(path.resolve(file), 'utf8'),
  writeFile: (file, text) => {
    // A fix can create a file, such as a migration, in a folder that does not exist yet.
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), text);
  },
};

function printFix(finding, index, total) {
  // Live-database findings name a table instead of a source position.
  const site = finding.file ? `${finding.file}:${finding.line}:${finding.column}` : finding.target;
  console.log(`\n[${index}/${total}] ${site} ${findingLabel(finding)}`);
  console.log('  ' + finding.message);
  for (const change of finding.fix.changes) {
    if (change.create) {
      console.log(`  ${change.file} (new file)`);
      for (const line of change.after.split('\n')) console.log('    + ' + line);
      continue;
    }
    console.log(`  ${change.file}:${change.line}`);
    for (const line of diffLines(change.before, change.after)) console.log(line);
  }
  if (finding.fix.note) console.log('  Note: ' + finding.fix.note);
}

// Records each written change for the fix history, and for the write tracker once `commit` confirms the write; the
// tracker later updates the recorded change to the text formatting leaves.
function captureFor(tracker, history) {
  const record = history?.begin();
  const written = [];
  const capture = (change) => {
    written.push(change);
    record?.(change);
  };
  capture.commit = () => {
    tracker.recordWrites(written.map((change) => ({ ...change, file: path.resolve(change.file), owner: change })));
  };
  return capture;
}

// `--no-comments`: drops the why-comment from each fix.
function withoutComments(findings, comments = true) {
  if (comments) return;
  for (const finding of findings) if (finding.fix) finding.fix = withoutWhyComment(finding.fix, finding.ruleId);
}

// Applies a fix where earlier fixes of this run have moved its lines.
function applyTracked(fix, tracker, capture) {
  return applyFixSafely(
    applyFix,
    tracker.rebase(fix, (file) => path.resolve(file)),
    fileAccess,
    { capture },
  );
}

// Applies the finding's fix and returns why it could not be applied, or undefined once it is. Two findings can share
// one change, such as a helper or a Set; once an earlier id made it, its original lines are gone, so the later id is
// recognised by its identical changes instead of by the file.
function chosenFixFailure(finding, appliedChanges, tracker, capture) {
  if (!finding) return 'unknown id';
  if (!finding.fix) return 'no automatic fix; this finding needs a manual change';
  const changes = JSON.stringify(finding.fix.changes);
  if (appliedChanges.has(changes)) return alreadyAppliedError;
  const { error } = applyTracked(finding.fix, tracker, capture);
  if (!error) {
    appliedChanges.add(changes);
    capture.commit();
  }
  return error;
}

// `--fix --only`: applies exactly the named fixes without asking and reports each id that could not be applied.
function applyChosenFixes(
  findings,
  ids,
  { json = false, checker = 'perf', project = process.cwd(), comments, format } = {},
) {
  const history = require('../shared/fix-history.cjs').checkerHistory(project, process.cwd(), checker);
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const chosen = ids.map((id) => findingsById.get(id)).filter(Boolean);
  require('./site-fix.cjs').attachSiteFixes(chosen);
  withoutComments(chosen, comments);
  const tracker = createWriteTracker();
  const applied = [];
  const alreadyApplied = [];
  const failed = [];
  const appliedChanges = new Set();
  for (const [index, id] of ids.entries()) {
    const finding = findingsById.get(id);
    const reason = chosenFixFailure(finding, appliedChanges, tracker, captureFor(tracker, history));
    if (!json && finding?.fix) printFix(finding, index + 1, ids.length);
    // Only a change made earlier in this run counts as done; one already in the file before the run is stale.
    if (reason === alreadyAppliedError && applied.length) {
      alreadyApplied.push({ id, status: alreadyAppliedError });
      if (!json) console.log('  Already applied by an earlier fix in this run.');
    } else if (reason) {
      failed.push({ id, reason });
      if (!json) console.log(`  ${id}: not applied, ${reason}.`);
    } else {
      applied.push(id);
      history?.accept(finding);
      if (!json) console.log('  Applied.');
    }
  }
  if (format !== false && applied.length) tracker.format(project ?? process.cwd());
  history?.finish(alreadyApplied, failed);
  if (json) console.log(JSON.stringify({ applied, alreadyApplied, failed }, null, 2));
  else {
    const shared = alreadyApplied.length ? `, ${alreadyApplied.length} already applied by another` : '';
    console.log(`\nApplied ${applied.length} of ${ids.length} chosen fix(es)${shared}.`);
    if (applied.length) console.log('Review the changes and run your tests; rerun the check to confirm.');
  }
  return failed.length ? 2 : 0;
}

async function applyFixes(
  findings,
  { all = false, project = process.cwd(), checker = 'perf', withheld = [], comments, format } = {},
) {
  const { attachSiteFixes } = require('./site-fix.cjs');
  attachSiteFixes(findings);
  withoutComments(findings, comments);
  const tracker = createWriteTracker();
  const fixable = findings.filter((finding) => finding.fix && (!all || !finding.fix.requiresReview));
  if (!all && !process.stdin.isTTY)
    throw new Error('--fix asks before each change; use --fix --yes without a terminal.');
  const history = require('../shared/fix-history.cjs').checkerHistory(project, process.cwd(), checker);
  if (history && withheld.length) attachSiteFixes(withheld);
  let applyRest = all;
  const applied = [];
  const failed = [];
  for (const [index, finding] of fixable.entries()) {
    printFix(finding, index + 1, fixable.length);
    if (!applyRest || finding.fix.requiresReview) {
      const choice = await askChoice('  Apply this fix? [y]es / [n]o / [a]ll remaining / [q]uit: ');
      if (choice === 'q') break;
      if (choice === 'n') continue;
      if (choice === 'a') applyRest = true;
    }
    const capture = captureFor(tracker, history);
    const result = applyTracked(finding.fix, tracker, capture);
    if (result.error) {
      failed.push({ id: finding.id, reason: result.error });
      console.log('  Skipped: ' + result.error + '.');
    } else {
      applied.push(finding);
      capture.commit();
      history?.accept(finding);
      console.log('  Applied.');
    }
  }
  if (format !== false && applied.length) tracker.format(project ?? process.cwd());
  history?.finish([], failed, findings.concat(withheld));
  const review = all ? findings.filter((finding) => finding.fix?.requiresReview).length : 0;
  const manual = findings.length - fixable.length - review;
  console.log(
    `\nApplied ${applied.length} of ${fixable.length} automatic fix(es)` +
      (failed.length ? `, ${failed.length} could not be applied` : '') +
      (review ? `; ${review} fix(es) require individual review` : '') +
      (manual ? `; ${manual} finding(s) need a manual change.` : '.'),
  );
  if (applied.length) console.log('Review the changes and run your tests; rerun the check to confirm.');
  if (failed.length) console.log('Rescan the project to review the remaining fixes.');
  return failed.length ? 2 : 0;
}

module.exports = { applyFixes, applyChosenFixes };
