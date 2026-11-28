// `--fix`: shows each available site fix as a diff and applies the ones the user accepts.
import fs from 'node:fs';
import path from 'node:path';
import { askChoice, labelledLines } from '../shared/fix-terminal.js';
import { applyFix } from '../editor/apply-fix.js';
import { diffLines, findingLabel } from './finding-text.js';
import { applyFixSafely } from '../shared/fix-safety.js';
import type { checkerHistory } from '../shared/fix-history.js';
import { createWriteTracker, withoutWhyComment } from '../shared/fix-presentation.js';
import type { Finding, FindingFix, FixChange } from '../shared/types.js';
import { checkerHistory as checkerHistoryFixHistory } from '../shared/fix-history.js';
import { attachSiteFixes, loadBuilders } from './site-fix.js';

type WriteTracker = ReturnType<typeof createWriteTracker>;
type FixHistory = ReturnType<typeof checkerHistory>;
type FixableFinding = Finding & { fix: FindingFix; id: string };

const hasFix = (finding: Finding): finding is FixableFinding => finding.fix !== undefined && finding.id !== undefined;

type FixFailure = {
  id: string;
  reason: string;
};

interface FixRunOptions {
  project?: string | null;
  checker?: string;
  comments?: boolean;
  format?: boolean;
}

interface ChosenFixOptions extends FixRunOptions {
  json?: boolean;
}

interface AllFixOptions extends FixRunOptions {
  all?: boolean;
  withheld?: Finding[];
}

// applyFix's error when every change of a fix is already in the file.
const alreadyAppliedError = 'already applied';

const fileAccess = {
  readFile: (file: string) => fs.readFileSync(path.resolve(file), 'utf8'),
  writeFile: (file: string, text: string) => {
    // A fix can create a file, such as a migration, in a folder that does not exist yet.
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), text);
  },
};

function printFix(finding: FixableFinding, index: number, total: number): void {
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
  if (finding.fix.note) for (const line of labelledLines('Note', finding.fix.note)) console.log(line);
}

// Records each written change for the fix history, and for the write tracker once `commit` confirms
// the write; the tracker later updates the recorded change to the text formatting leaves.
type FixCapture = ReturnType<typeof captureFor>;

function captureFor(tracker: WriteTracker, history: FixHistory) {
  const record = history?.begin();
  const written: FixChange[] = [];
  const capture = (change: FixChange) => {
    written.push(change);
    record?.(change);
  };
  capture.commit = () => {
    tracker.recordWrites(written.map((change) => ({ ...change, file: path.resolve(change.file), owner: change })));
  };
  return capture;
}

// `--no-comments`: drops the why-comment from each fix.
function withoutComments(findings: Finding[], comments = true): void {
  if (comments) return;
  for (const finding of findings) if (finding.fix) finding.fix = withoutWhyComment(finding.fix, finding.ruleId);
}

// Applies a fix where earlier fixes of this run have moved its lines.
function applyTracked(fix: FindingFix, tracker: WriteTracker, capture: FixCapture) {
  return applyFixSafely(
    applyFix,
    tracker.rebase(fix, (file: string) => path.resolve(file)),
    fileAccess,
    { capture },
  );
}

// Applies the finding's fix and returns why it could not be applied, or undefined once it is. Two
// findings can share one change, such as a helper or a Set; once an earlier id made it, its
// original lines are gone, so the later id is recognised by its identical changes instead of by the
// file.
function chosenFixFailure(
  finding: Finding | undefined,
  appliedChanges: Set<string>,
  tracker: WriteTracker,
  capture: FixCapture,
): string | undefined {
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

async function attachLoadedSiteFixes(findings: Finding[]): Promise<void> {
  if (!findings.length) return;
  await loadBuilders();
  attachSiteFixes(findings);
}

// `--fix --only`: applies exactly the named fixes without asking and reports each id that could not
// be applied.
async function applyChosenFixes(
  findings: Finding[],
  ids: readonly string[],
  { json = false, checker = 'perf', project = process.cwd(), comments, format }: ChosenFixOptions = {},
): Promise<number> {
  const history = checkerHistoryFixHistory(project, process.cwd(), checker);
  const findingsById = new Map(findings.map((finding): [string | undefined, Finding] => [finding.id, finding]));
  const chosen = ids.map((id) => findingsById.get(id)).filter((finding): finding is Finding => finding !== undefined);
  await attachLoadedSiteFixes(chosen);
  withoutComments(chosen, comments);
  const tracker = createWriteTracker();
  const applied: string[] = [];
  const alreadyApplied: { id: string; status: string }[] = [];
  const failed: FixFailure[] = [];
  const appliedChanges = new Set<string>();
  for (const [index, id] of ids.entries()) {
    const finding = findingsById.get(id);
    const reason = chosenFixFailure(finding, appliedChanges, tracker, captureFor(tracker, history));
    if (!json && finding && hasFix(finding)) printFix(finding, index + 1, ids.length);
    // Only a change made earlier in this run counts as done; one already in the file before the run
    // is stale.
    if (reason === alreadyAppliedError && applied.length) {
      alreadyApplied.push({ id, status: alreadyAppliedError });
      if (!json) console.log('  Already applied by an earlier fix in this run.');
    } else if (reason) {
      failed.push({ id, reason });
      if (!json) console.log(`  ${id}: not applied, ${reason}.`);
    } else {
      applied.push(id);
      if (finding) history?.accept(finding);
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

const applyPrompt = '  Apply this fix? [y]es / [n]o / [a]ll remaining / [q]uit: ';

interface AutomaticSummary {
  readonly applied: number;
  readonly failed: number;
  readonly fixable: number;
  readonly findings: readonly Finding[];
  readonly all: boolean;
}

function printAutomaticSummary({ applied, failed, fixable, findings, all }: AutomaticSummary): void {
  const review = all ? findings.filter((finding: Finding) => finding.fix?.requiresReview).length : 0;
  const manual = findings.length - fixable - review;
  console.log(
    `\nApplied ${applied} of ${fixable} automatic fix(es)` +
      (failed ? `, ${failed} could not be applied` : '') +
      (review ? `; ${review} fix(es) require individual review` : '') +
      (manual ? `; ${manual} finding(s) need a manual change.` : '.'),
  );
}

async function applyFixes(
  findings: Finding[],
  { all = false, project = process.cwd(), checker = 'perf', withheld = [], comments, format }: AllFixOptions = {},
): Promise<number> {
  if (findings.length || withheld.length) await loadBuilders();
  attachSiteFixes(findings);
  withoutComments(findings, comments);
  const tracker = createWriteTracker();
  const fixable = findings.filter(
    (finding): finding is FixableFinding => hasFix(finding) && (!all || !finding.fix.requiresReview),
  );
  if (!all && !process.stdin.isTTY)
    throw new Error('--fix asks before each change; use --fix --yes without a terminal.');
  const history = checkerHistoryFixHistory(project, process.cwd(), checker);
  if (history && withheld.length) attachSiteFixes(withheld);
  let applyRest = all;
  const applied: Finding[] = [];
  const failed: FixFailure[] = [];
  for (const [index, finding] of fixable.entries()) {
    printFix(finding, index + 1, fixable.length);
    if (!applyRest || finding.fix.requiresReview) {
      const choice = await askChoice(applyPrompt);
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
  printAutomaticSummary({ applied: applied.length, failed: failed.length, fixable: fixable.length, findings, all });
  if (applied.length) console.log('Review the changes and run your tests; rerun the check to confirm.');
  if (failed.length) console.log('Rescan the project to review the remaining fixes.');
  return failed.length ? 2 : 0;
}

export { applyFixes, applyChosenFixes };
