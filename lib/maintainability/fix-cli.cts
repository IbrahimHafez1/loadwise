// `--fix`: shows each available site fix as a diff and applies the ones the user accepts.
import fs from 'node:fs';
import path from 'node:path';
import { askChoice, labelledLines } from '../shared/fix-terminal.cjs';
import { applyFix } from './apply-fix.cjs';
import { applyFixSafely } from '../shared/fix-safety.cjs';
import { diffLines } from './fix-text.cjs';
import { createWriteTracker, withoutWhyComment } from '../shared/fix-presentation.cjs';
import type { Finding, FindingFix, FixChange } from '../shared/types.cjs';
import type { ChangeCapture, FileAccessors, FixRunOptions } from './types/fix-files.cjs';
import { applyBulkFixes } from '../shared/fix.cjs';
import { checkerHistory } from '../shared/fix-history.cjs';
import type * as FixHistory from '../shared/fix-history.cjs';

type WriteTracker = ReturnType<typeof createWriteTracker>;
type CheckerHistory = NonNullable<ReturnType<typeof FixHistory.checkerHistory>>;

// A finding that carries its fix.
type FixableFinding = Finding & { fix: FindingFix };

const byteOrderMark = '\uFEFF';

// Fix changes name project-relative files. A byte order mark is kept out of the matched text and
// written back.
function projectFiles(root: string): FileAccessors {
  const marked = new Set<string>();
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

function printFix(finding: Finding, fix: FindingFix, index: number, total: number): void {
  console.log(`\n[${index}/${total}] ${finding.file}:${finding.line}:${finding.column} [${finding.ruleId}]`);
  console.log('  ' + finding.message);
  for (const change of fix.changes) {
    console.log(`  ${change.file}:${change.line}`);
    for (const line of diffLines(change.before, change.after)) console.log(line);
  }
  if (fix.note) for (const line of labelledLines('Note', fix.note)) console.log(line);
}

const alreadyAppliedSuffix = 'already applied';

// Records each written change for the fix history, and for the write tracker once `commit` confirms
// the write.
function captureFor(tracker: WriteTracker, root: string, history: CheckerHistory | undefined): ChangeCapture {
  const record = history?.begin();
  const written: FixChange[] = [];
  const capture: ChangeCapture = (change: FixChange) => {
    written.push(change);
    record?.(change);
  };
  capture.commit = () => {
    tracker.recordWrites(
      written.map((change) => ({ ...change, file: path.resolve(root, change.file), owner: change })),
    );
  };
  return capture;
}

// `--no-comments`: drops the why-comment from each fix.
function withoutComments(findings: Finding[], comments = true): void {
  if (comments) return;
  for (const finding of findings) if (finding.fix) finding.fix = withoutWhyComment(finding.fix, finding.ruleId);
}

// Applies the finding's fix where earlier fixes of this run have moved its lines.
function applyFinding(
  finding: Finding,
  findingFix: FindingFix,
  root: string,
  files: FileAccessors,
  tracker: WriteTracker,
  capture: ChangeCapture,
): { error?: string } {
  const fix = tracker.rebase(findingFix, (file) => path.resolve(root, file));
  if (!fix.changes.some((change: FixChange) => change.create)) return applyFixSafely(applyFix, fix, files, capture);
  // An extraction must publish the new module and rewrite its consumers together.
  try {
    const { refused } = applyBulkFixes([{ ...finding, fix }], root, {
      includeReview: true,
    });
    if (refused.length) return { error: refused[0].reason };
    fix.changes.forEach(capture);
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// `--fix --only`: applies exactly the named fixes without asking. An id whose change an earlier id
// in the same run already made counts as done; any other id that cannot be applied is a failure.
function applyChosenFixes(
  findings: Finding[],
  ids: readonly string[],
  root: string,
  { json = false, comments, format }: FixRunOptions = {},
): number {
  const history = checkerHistory(root, root, 'maint');
  const findingsById = new Map<string, Finding>();
  for (const finding of findings) if (finding.id !== undefined) findingsById.set(finding.id, finding);
  const files = projectFiles(root);
  withoutComments(findings, comments);
  const tracker = createWriteTracker();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const [index, id] of ids.entries()) {
    const finding = findingsById.get(id);
    if (finding?.fix && !json) printFix(finding, finding.fix, index + 1, ids.length);
    const capture = captureFor(tracker, root, history);
    const error = !finding
      ? 'unknown id'
      : !finding.fix
        ? 'no automatic fix; this finding needs a manual change'
        : applyFinding(finding, finding.fix, root, files, tracker, capture).error;
    if (finding && !error) {
      applied.push(id);
      capture.commit();
      history?.accept(finding);
    } else if (error?.endsWith(alreadyAppliedSuffix)) alreadyApplied.push(id);
    else failed.push({ id, reason: error ?? '' });
    if (json) continue;
    if (!error) console.log('  Applied.');
    else if (error.endsWith(alreadyAppliedSuffix)) console.log(`  ${id}: already applied by an earlier fix.`);
    else console.log(`  ${id}: not applied, ${error}.`);
  }
  if (format !== false && applied.length) tracker.format(root);
  history?.finish(alreadyApplied, failed);
  if (json) console.log(JSON.stringify({ applied, alreadyApplied, failed }, null, 2));
  else {
    console.log(`
Applied ${applied.length} of ${ids.length} chosen fix(es).`);
    if (applied.length) console.log('Review the changes and run your tests; rerun the check to confirm.');
  }
  return failed.length ? 2 : 0;
}

// Findings must already carry their site fixes. Several fixes can touch one function; a later fix
// whose lines an earlier one changed is skipped as stale and reappears, rebuilt, on the next run.
async function applyFixes(
  findings: Finding[],
  root: string,
  { all = false, comments, format }: FixRunOptions & { all?: boolean } = {},
): Promise<number> {
  if (!all && !process.stdin.isTTY)
    throw new Error('--fix asks before each change; use --fix --yes without a terminal.');
  const history = checkerHistory(root, root, 'maint');
  const fixable = findings.filter(
    (finding): finding is FixableFinding => Boolean(finding.fix) && (!all || !finding.fix?.requiresReview),
  );
  const files = projectFiles(root);
  withoutComments(findings, comments);
  const tracker = createWriteTracker();
  let applyRest = all;
  let applied = 0;
  const alreadyApplied: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const [index, finding] of fixable.entries()) {
    printFix(finding, finding.fix, index + 1, fixable.length);
    if (!applyRest || finding.fix.requiresReview) {
      const choice = await askChoice('  Apply this fix? [y]es / [n]o / [a]ll remaining / [q]uit: ');
      if (choice === 'q') break;
      if (choice === 'n') continue;
      if (choice === 'a') applyRest = true;
    }
    const capture = captureFor(tracker, root, history);
    const result = applyFinding(finding, finding.fix, root, files, tracker, capture);
    if (result.error?.endsWith(alreadyAppliedSuffix)) {
      alreadyApplied.push(finding.id ?? '');
      console.log('  Already applied by an earlier fix.');
    } else if (result.error) {
      failed.push({ id: finding.id ?? '', reason: result.error });
      console.log('  Skipped: ' + result.error + '.');
    } else {
      applied++;
      capture.commit();
      history?.accept(finding);
      console.log('  Applied.');
    }
  }
  if (format !== false && applied) tracker.format(root);
  history?.finish(alreadyApplied, failed, findings);
  const review = all ? findings.filter((finding: Finding) => finding.fix?.requiresReview).length : 0;
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

export { applyFixes, applyChosenFixes };
