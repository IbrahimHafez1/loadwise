// Applies a site fix to file text. A fix stores the exact original lines, so it is applied only
// where those lines still exist; an edit made since the scan moves or removes them and the fix then
// refuses instead of guessing.

import { isChangeApplied, locateChange } from '../editor/apply-fix.js';
import type { ApplyResult, TextResult } from '../editor/apply-fix.js';
import type { FindingFix, FixChange } from '../shared/types.js';
import type { FileAccessors, CaptureChange } from './types/fix-files.js';

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// Findings of one import share one rewrite, so once it is written the others' original lines are
// gone. The changes written to each file, valid while the file still holds the text written, tell
// that apart from a real edit made since the scan. Kept per run by the caller, so nothing outlives it.
type WrittenByFile = Map<string, { text: string; identities: Set<string> }>;

const changeIdentity = (change: FixChange): string => JSON.stringify([change.file, change.before, change.after]);

function writtenThisRun(writtenByFile: WrittenByFile, file: string, text: string, change: FixChange): boolean {
  const written = writtenByFile.get(file);
  return written?.text === text && written.identities.has(changeIdentity(change));
}

function rememberWritten(
  writtenByFile: WrittenByFile,
  file: string,
  text: string,
  changes: readonly FixChange[],
): void {
  const identities = new Set(changes.map(changeIdentity));
  const previous = writtenByFile.get(file);
  for (const identity of previous?.identities ?? []) identities.add(identity);
  writtenByFile.set(file, { text, identities });
}

// A rewrite whose result is already at the reported place, or that this run wrote, is not stale.
function isAlreadyInFile(
  text: string,
  lines: readonly string[],
  change: FixChange,
  writtenByFile: WrittenByFile,
): boolean {
  if (writtenThisRun(writtenByFile, change.file, text, change)) return true;
  if (change.after.trim() === '') return false;
  return locateChange([...lines], { ...change, before: change.after }) !== -1;
}

// Returns the new text, or { error } when the code no longer matches the scan.
function applyChangesToText(
  text: string,
  changes: readonly FixChange[],
  capture?: CaptureChange,
  writtenByFile: WrittenByFile = new Map(),
): TextResult {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const located: { row: number; removed: number; added: string[] }[] = [];
  for (const change of changes) {
    const row = locateChange(lines, change);
    if (row === -1) {
      if (isAlreadyInFile(text, lines, change, writtenByFile)) return { error: 'already applied' };
      return { error: `the code at line ${change.line} changed since the scan` };
    }
    const after = splitLines(change.after);
    // An added import keeps the original lines, so look for the rewritten block before applying it
    // again.
    if (isChangeApplied(lines, row, change)) return { error: 'already applied' };
    located.push({ row, removed: splitLines(change.before).length, added: after });
  }
  located.sort((left, right) => right.row - left.row);
  for (let index = 1; index < located.length; index++) {
    if (located[index].row + located[index].removed > located[index - 1].row) return { error: 'overlapping changes' };
  }
  for (const { row, removed, added } of located) {
    const original = lines.splice(row, removed, ...added);
    capture?.({ file: changes[0].file, line: row + 1, before: original.join('\n'), after: added.join('\n') });
  }
  return { text: lines.join(newline) };
}

// Groups a fix's changes by file and applies them through the given file accessors.
function applyFix(
  fix: Pick<FindingFix, 'changes'>,
  { readFile, writeFile }: FileAccessors,
  capture?: CaptureChange,
  writtenByFile: WrittenByFile = new Map(),
): ApplyResult {
  const byFile = new Map<string, FixChange[]>();
  for (const change of fix.changes) {
    const changesOfFile = byFile.get(change.file) ?? [];
    changesOfFile.push(change);
    byFile.set(change.file, changesOfFile);
  }
  const updates: [string, string][] = [];
  const captured: FixChange[] = [];
  const collect: CaptureChange | undefined = capture ? (change) => captured.push(change) : undefined;
  for (const [file, changes] of byFile) {
    const result = applyChangesToText(readFile(file), changes, collect, writtenByFile);
    if (result.error !== undefined) return { error: `${file}: ${result.error}` };
    updates.push([file, result.text]);
  }
  // Every file is checked before any is written, so a stale fix never leaves a half-applied change.
  for (const [file, text] of updates) {
    writeFile(file, text);
    rememberWritten(writtenByFile, file, text, byFile.get(file) ?? []);
  }
  if (capture) for (const change of captured) capture(change);
  return { files: updates.map(([file]) => file) };
}

export type { WrittenByFile };
export { applyChangesToText, applyFix, locateChange };
