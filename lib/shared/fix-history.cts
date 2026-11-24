// @ts-check
import fs from 'node:fs';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isAgentSession } from './agent-session.cjs';
import type { Finding, FixChange } from './types.cjs';
import type { HistoryStorage, ReviewOutcome } from './types/review-history.cjs';
import { findProjectRoot } from './agent-init.cjs';
import { realTarget } from './real-target.cjs';
import { pillars } from './pillars.cjs';

type OutcomeGroup = 'applied' | 'manual' | 'pendingReview' | 'alreadyApplied' | 'failed';

/** A finding as a history receipt records it, with the checker that reported it. */
interface ReceiptFinding {
  id?: string;
  checker?: string;
  ruleId: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  related?: unknown;
  fix?: { note?: string; requiresReview?: boolean; changes: FixChange[] };
}

/** A finding id (or a record with one) a fix run could not apply or found already applied. */
type OutcomeItem = string | { id: string; [detail: string]: unknown };

interface TaggedOutcome {
  id: string;
  checker: string;
  [detail: string]: unknown;
}

interface ReceiptGroups {
  applied: ReceiptFinding[];
  manual: ReceiptFinding[];
  pendingReview: ReceiptFinding[];
  alreadyApplied: TaggedOutcome[];
  failed: TaggedOutcome[];
}

/** One finding or outcome inside a stored history record. */
interface StoredEntry {
  id?: string;
  checker?: string;
  [detail: string]: unknown;
}

/** A history record as stored on disk. */
interface HistoryRecord {
  at?: string;
  directory?: string;
  applied?: StoredEntry[];
  manual?: StoredEntry[];
  pendingReview?: StoredEntry[];
  alreadyApplied?: StoredEntry[];
  failed?: StoredEntry[];
  outcomes?: ReviewOutcome[];
}

interface BulkFixResult {
  applied: Finding[];
  manual: Finding[];
  pendingReview: Finding[];
}

interface CheckerHistory {
  begin(): (change: FixChange) => number;
  accept(finding: Finding): void;
  finish(alreadyApplied: readonly OutcomeItem[], failed: readonly OutcomeItem[], findings?: readonly Finding[]): void;
}

interface HistoryReport {
  enabled: boolean;
  runs: HistoryRecord[];
  reviews: ReviewOutcome[];
}

const runFile = /^\d{13}-\d{20}-[0-9a-f-]{36}\.json$/;
const reviewFile = /^\d{13}-\d{20}-[0-9a-f-]{36}\.review\.json$/;
const outcomes: readonly OutcomeGroup[] = ['applied', 'manual', 'pendingReview', 'alreadyApplied', 'failed'];

function stateHome(): string {
  const home = os.homedir();
  const windows = process.platform === 'win32';
  const configured = windows ? process.env.LOCALAPPDATA : process.env.XDG_STATE_HOME;
  if (configured && path.isAbsolute(configured)) return configured;
  return windows ? path.join(home, 'AppData', 'Local') : path.join(home, '.local', 'state');
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function privateEntry(file: string, stat: Stats): void {
  if (stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))) {
    throw new Error('Expected a private, user-owned Loadwise history path: ' + file);
  }
}

function storage(project: string, create: true, suffix?: string): HistoryStorage;
function storage(project: string, create: boolean, suffix?: string): HistoryStorage | undefined;
function storage(project: string, create: boolean, suffix = ''): HistoryStorage | undefined {
  const root = fs.realpathSync.native(findProjectRoot(project));
  const parts = ['loadwise', 'review-history', createHash('sha256').update(root).digest('hex') + suffix];
  const base = stateHome();
  const destination = path.join(base, ...parts);
  if (within(root, destination)) throw new Error('Loadwise review history must be outside the project.');
  if (create) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const baseStat = fs.lstatSync(base, { throwIfNoEntry: false });
  if (!baseStat) return;
  if (!baseStat.isDirectory() || (process.getuid && (baseStat.uid !== process.getuid() || baseStat.mode & 0o022))) {
    throw new Error('Expected a user-owned local state directory: ' + base);
  }
  let directory = fs.realpathSync.native(base);
  if (within(root, path.join(directory, ...parts)))
    throw new Error('Loadwise review history must be outside the project.');
  for (const part of parts) {
    directory = path.join(directory, part);
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return;
    privateEntry(directory, stat);
    if (!stat.isDirectory()) throw new Error('Expected a review history directory: ' + directory);
  }
  return { root, directory };
}

function enableHistory(project: string): string {
  return storage(project, true).directory;
}

// An inbox shares the checkout's private storage rules but does not opt the user into fix history.
function pendingReviewStorage(directory: string, create: true): HistoryStorage;
function pendingReviewStorage(directory: string, create: boolean): HistoryStorage | undefined;
function pendingReviewStorage(directory: string, create: boolean): HistoryStorage | undefined {
  return storage(fs.realpathSync.native(directory), create, '.pending');
}

// The original directory means the user explicitly enabled recording for manual CLI fixes.
const agentOnlySuffix = '.agent';

function readableHistory(project: string): HistoryStorage[] {
  return [storage(project, false), storage(project, false, agentOnlySuffix)].filter(
    (history): history is HistoryStorage => history !== undefined,
  );
}

function sourceHistoryProject(directory: string, files: readonly string[]): string | null {
  if (!files.length) return directory;
  const roots = [...new Set(files.map((file) => findProjectRoot(path.dirname(path.resolve(file)))))];
  if (roots.length === 1) return roots[0];
  if (isAgentSession() || roots.some((root) => historyForFix(root))) {
    console.error(
      'Review history cannot record fixes spanning separate projects. Run each project separately to record its edits.',
    );
  }
  return null;
}

function historyForFix(project: string | null): HistoryStorage | undefined {
  if (project === null) return;
  try {
    return storage(project, false) ?? (isAgentSession() ? storage(project, true, agentOnlySuffix) : undefined);
  } catch (error) {
    console.error('Loadwise review history unavailable: ' + (error instanceof Error ? error.message : String(error)));
  }
}

// Receipts contain the finding and its edited lines. Examples and unrelated source file contents
// stay out.
function receiptFinding(finding: Finding, checker?: string, changes?: FixChange[]): ReceiptFinding {
  const { id, ruleId, file, line, column, message, related, fix } = finding;
  return {
    id,
    checker: typeof finding.checker === 'string' ? finding.checker : checker,
    ruleId,
    file,
    line,
    column,
    message,
    related,
    ...(fix && { fix: { note: fix.note, requiresReview: fix.requiresReview, changes: changes ?? fix.changes } }),
  };
}

function writeRecord(directory: string, filenameSuffix: string, data: object): void {
  const timestamp = new Date();
  // Same-millisecond decisions must replay in the order they were written.
  const sequence = process.hrtime.bigint().toString().padStart(20, '0');
  const prefix = path.join(directory, [timestamp.getTime(), sequence, randomUUID()].join('-'));
  const temporary = prefix + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify({ at: timestamp.toISOString(), ...data }));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, prefix + filenameSuffix);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeReceipt(history: HistoryStorage | undefined, directory: string, groups: ReceiptGroups): void {
  if (!history || !groups.applied.length) return;
  try {
    const inProject = (change: FixChange) => within(history.root, realTarget(path.resolve(directory, change.file)));
    if (!groups.applied.every((finding: ReceiptFinding) => (finding.fix?.changes ?? []).every(inProject))) {
      throw new Error('an edited file lies outside the initialized project');
    }
    for (const finding of groups.pendingReview) {
      if (finding.fix) finding.fix.changes = finding.fix.changes.filter(inProject);
    }
    writeRecord(history.directory, '.json', { directory: path.resolve(directory), ...groups });
  } catch (error) {
    console.error(
      'Fixes were applied, but Loadwise could not save their review history: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

function recordBulk(directory: string, result: BulkFixResult): void {
  const history = historyForFix(directory);
  if (!history) return;
  const pack = (findings: Finding[]) => findings.map((finding: Finding) => receiptFinding(finding));
  writeReceipt(history, directory, {
    applied: pack(result.applied),
    manual: pack(result.manual),
    pendingReview: pack(result.pendingReview),
    alreadyApplied: [],
    failed: [],
  });
}

function checkerHistory(project: string | null, directory: string, checker: string): CheckerHistory | undefined {
  const history = historyForFix(project);
  if (!history) return;
  const applied: ReceiptFinding[] = [];
  let pending: FixChange[] | undefined;
  return {
    begin() {
      const collected: FixChange[] = [];
      pending = collected;
      return (change: FixChange) => collected.push(change);
    },
    accept(finding: Finding) {
      applied.push(receiptFinding(finding, checker, pending));
    },
    finish(alreadyApplied, failed, findings = []) {
      if (!applied.length) return;
      const tagged = (items: readonly OutcomeItem[]): TaggedOutcome[] =>
        items.map((item: OutcomeItem) => ({ ...(typeof item === 'string' ? { id: item } : item), checker }));
      const groups: ReceiptGroups = {
        applied,
        manual: [],
        pendingReview: [],
        alreadyApplied: tagged(alreadyApplied),
        failed: tagged(failed),
      };
      const handled = new Set([...applied, ...groups.alreadyApplied, ...groups.failed].map(({ id }) => id));
      for (const finding of findings) {
        if (handled.has(finding.id)) continue;
        const remaining = finding.fix ? groups.pendingReview : groups.manual;
        remaining.push(receiptFinding(finding, checker));
      }
      writeReceipt(history, directory, groups);
    },
  };
}

function parseReceipt(text: string, file: string): HistoryRecord {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid Loadwise history file: ' + file);
  }
}

function readReceipt(directory: string, name: string): HistoryRecord {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  privateEntry(file, stat);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid Loadwise history file: ' + file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (stat.dev !== opened.dev || stat.ino !== opened.ino)
      throw new Error('Review history changed while opening: ' + file);
    return parseReceipt(fs.readFileSync(fd, 'utf8'), file);
  } finally {
    fs.closeSync(fd);
  }
}

function selectOutcomes(run: HistoryRecord, selected: ReadonlySet<string>): HistoryRecord | undefined {
  if (!selected.size) return run;
  for (const key of outcomes) {
    run[key] = (run[key] ?? []).filter(
      (finding: StoredEntry) => finding.checker !== undefined && selected.has(finding.checker),
    );
  }
  if (outcomes.some((key) => (run[key] ?? []).length)) return run;
}

function reviewKey(outcome: Pick<ReviewOutcome, 'checker' | 'id'>): string {
  return outcome.checker + '/' + outcome.id;
}

function* records(histories: readonly HistoryStorage[], pattern: RegExp): Generator<HistoryRecord> {
  const files = histories.flatMap(({ directory }) =>
    fs
      .readdirSync(directory)
      .filter((name: string) => pattern.test(name))
      .map((name: string) => ({ directory, name })),
  );
  for (const { directory, name } of files.sort((first, second) => first.name.localeCompare(second.name))) {
    yield readReceipt(directory, name);
  }
}

function latestReviews(histories: readonly HistoryStorage[]): Map<string, ReviewOutcome> {
  const entries = new Map<string, ReviewOutcome>();
  for (const record of records(histories, reviewFile)) {
    for (const outcome of record.outcomes ?? []) entries.set(reviewKey(outcome), outcome);
  }
  return entries;
}

function saveReviewOutcomes(project: string, outcomes: readonly ReviewOutcome[]): number {
  const histories = readableHistory(project);
  const history = histories[0] ?? (isAgentSession() ? storage(project, true, agentOnlySuffix) : undefined);
  if (!history) throw new Error('Initialize local review history with loadwise agent init before saving outcomes.');
  const previous = latestReviews(histories);
  const changed: ReviewOutcome[] = [];
  for (const { id, checker, ruleId, file, line, column, status, evidence } of outcomes) {
    const outcome = { id, checker, ruleId, file, line, column, status, evidence };
    if (JSON.stringify(previous.get(reviewKey(outcome))) !== JSON.stringify(outcome)) changed.push(outcome);
  }
  if (changed.length) writeRecord(history.directory, '.review.json', { outcomes: changed });
  return changed.length;
}

function historyReport(project: string, args: readonly string[]): HistoryReport {
  const selected = new Set<string>(
    args
      .flatMap((arg: string) => arg.split(','))
      .map((name: string) => {
        const pillar = pillars.find((candidate) => candidate.name === name || candidate.jsonKey === name);
        if (!pillar) throw new Error('Unknown checker in agent history: ' + name);
        return pillar.name;
      }),
  );
  const histories = readableHistory(project);
  const runs: HistoryRecord[] = [];
  for (const record of records(histories, runFile)) {
    const run = selectOutcomes(record, selected);
    if (run) runs.push(run);
  }
  const reviews = [...latestReviews(histories).values()].filter(
    (outcome) => !selected.size || selected.has(outcome.checker),
  );
  return { enabled: histories.length > 0 || isAgentSession(), runs, reviews };
}

export {
  enableHistory,
  recordBulk,
  checkerHistory,
  historyReport,
  saveReviewOutcomes,
  sourceHistoryProject,
  pendingReviewStorage,
};
