// Dismissed findings live in .loadwise/dismissed.json at the workspace folder root, never in the
// user's code. A finding is matched by file, rule and the trimmed text of its flagged line, so it
// stays hidden across rescans and line shifts and returns once that line changes. An entry without
// line text hides the rule for the whole file. Paths are stored relative to the folder, so the file
// can be shared through version control.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../shared/atomic-write.js';
import { isRecord } from '../shared/is-record.js';
import type { DismissalEntry, Dismissals } from './types/dismissal.js';

const dismissalsPath = path.join('.loadwise', 'dismissed.json');

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

function readEntries(filename: string, root: string): DismissalEntry[] {
  let stored: unknown;
  try {
    stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    // No file yet, or one that is being rewritten: nothing is dismissed until it parses.
    return [];
  }
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item: unknown) => storedEntry(root, item) ?? []);
}

function serialize(root: string, entries: readonly DismissalEntry[]): string {
  const stored = entries.map(({ file, ruleId, lineText }) => ({
    file: path.relative(root, file).split(path.sep).join('/'),
    ruleId,
    ...(typeof lineText === 'string' ? { lineText } : {}),
  }));
  return JSON.stringify(stored, null, 2) + '\n';
}

function createDismissals(root: string): Dismissals {
  const filename = path.join(root, dismissalsPath);
  let current = readEntries(filename, root);
  let keys = new Set(current.map(keyOf));
  let pendingWrite: Promise<void> = Promise.resolve();
  function replace(next: DismissalEntry[]): void {
    current = next;
    keys = new Set(current.map(keyOf));
  }
  // Writes run one after another, each on the latest entries, so quick dismissals never lose one.
  function update(transform: (entries: DismissalEntry[]) => DismissalEntry[]): Promise<void> {
    const next = pendingWrite
      .catch(() => {})
      .then(() => {
        replace(transform(readEntries(filename, root)));
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        writeFileAtomic(filename, serialize(root, current));
      });
    pendingWrite = next;
    return next;
  }
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
    reload() {
      replace(readEntries(filename, root));
    },
  };
}

export { createDismissals, dismissalsPath };
