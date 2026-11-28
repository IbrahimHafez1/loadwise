// Dismissed findings live in .loadwise/dismissed.json at the workspace folder root, never in the
// user's code. A finding is matched by file, rule and the trimmed text of its flagged line, so it
// stays hidden across rescans and line shifts and returns once that line changes. An entry without
// line text hides the rule for the whole file. Paths are stored relative to the folder, so the file
// can be shared through version control.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../shared/atomic-write.js';
import { errorMessage } from '../shared/error-code.js';
import { isRecord } from '../shared/is-record.js';
import { isRealPathInside } from './workspace-paths.js';
import type { DismissalEntry, Dismissals } from './types/dismissal.js';

/** The saved dismissals, or why the file cannot be read; such a file is never overwritten. */
type StoredDismissals = { entries: DismissalEntry[]; problem?: undefined } | { problem: string; entries?: undefined };

interface DismissalsOptions {
  /** The file exists but cannot be used; the message names it and the reason. */
  onProblem(message: string): void;
}

const dismissalsPath = path.join('.loadwise', 'dismissed.json');
// The file is read synchronously on every change to it; a file this large is not a list of
// dismissals anyone curates, and parsing it would stall the server.
const maxDismissalBytes = 4 * 1024 * 1024;

function keyOf({ file, ruleId, lineText }: DismissalEntry): string {
  return JSON.stringify([file, ruleId, lineText ?? null]);
}

function storedEntry(root: string, stored: unknown): DismissalEntry | undefined {
  if (!isRecord(stored) || typeof stored.file !== 'string' || typeof stored.ruleId !== 'string') return;
  if (stored.file.includes('\0')) return;
  const entry: DismissalEntry = { file: path.resolve(root, stored.file), ruleId: stored.ruleId };
  if (typeof stored.lineText === 'string') entry.lineText = stored.lineText;
  return entry;
}

function readEntries(filename: string, root: string): StoredDismissals {
  let stored: unknown;
  try {
    const size = fs.statSync(filename, { throwIfNoEntry: false })?.size;
    if (size === undefined) return { entries: [] };
    if (size > maxDismissalBytes) return { problem: 'is larger than ' + maxDismissalBytes / 1024 / 1024 + ' MB' };
    stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    return { problem: 'cannot be read: ' + errorMessage(error) };
  }
  if (!Array.isArray(stored)) return { problem: 'does not hold a list of dismissals' };
  return { entries: stored.flatMap((item: unknown) => storedEntry(root, item) ?? []) };
}

function serialize(root: string, entries: readonly DismissalEntry[]): string {
  const stored = entries.map(({ file, ruleId, lineText }) => ({
    file: path.relative(root, file).split(path.sep).join('/'),
    ruleId,
    ...(typeof lineText === 'string' ? { lineText } : {}),
  }));
  return JSON.stringify(stored, null, 2) + '\n';
}

function createDismissals(root: string, { onProblem }: DismissalsOptions): Dismissals {
  const filename = path.join(root, dismissalsPath);
  const describe = (problem: string) => dismissalsPath.split(path.sep).join('/') + ' in ' + root + ' ' + problem + '.';
  let current: DismissalEntry[] = [];
  let keys = new Set<string>();
  let pendingWrite: Promise<void> = Promise.resolve();
  function replace(next: DismissalEntry[]): void {
    current = next;
    keys = new Set(current.map(keyOf));
  }
  // A file that does not parse keeps the dismissals already shown: it may be mid-rewrite by a
  // checkout, and an edit the user is still making should not flood the editor with findings.
  function load(): void {
    const stored = readEntries(filename, root);
    if (stored.entries) replace(stored.entries);
    else onProblem(describe(stored.problem));
  }
  // Writes run one after another, each on the latest saved entries, so quick dismissals never lose
  // one. The shown state changes only once the file holds it.
  function update(transform: (entries: DismissalEntry[]) => DismissalEntry[]): Promise<void> {
    const next = pendingWrite
      .catch(() => {})
      .then(() => {
        const stored = readEntries(filename, root);
        if (stored.entries === undefined) {
          throw new Error(describe(stored.problem) + ' Fix or remove it, then try again; it was left unchanged.');
        }
        if (!isRealPathInside(root, filename)) {
          throw new Error(describe('resolves outside the workspace folder') + ' Nothing was written.');
        }
        const entries = transform(stored.entries);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        writeFileAtomic(filename, serialize(root, entries));
        replace(entries);
      });
    pendingWrite = next;
    return next;
  }
  load();
  return {
    entries: () => [...current],
    has(site) {
      return keys.has(keyOf(site)) || keys.has(keyOf({ file: site.file, ruleId: site.ruleId }));
    },
    add(entry) {
      const key = keyOf(entry);
      return update((entries) => [...entries.filter((existing) => keyOf(existing) !== key), entry]);
    },
    remove(removed) {
      const gone = new Set(removed.map(keyOf));
      return update((entries) => entries.filter((entry) => !gone.has(keyOf(entry))));
    },
    reload: load,
  };
}

export { createDismissals, dismissalsPath };
