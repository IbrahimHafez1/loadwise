// Applies a site fix to file text. A fix stores the exact original lines, so it is applied only
// where those lines still exist; an edit made since the scan moves or removes them and the fix then
// refuses instead of guessing.

import { isChangeApplied, locateChange } from '../../editor/apply-fix.cjs';
import type { ApplyResult, TextResult } from '../../editor/apply-fix.cjs';
import type { FindingFix, FixChange } from '../shared/types.js';
import type { FileAccessors, CaptureChange } from './types/fix-files.js';

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// Returns the new text, or { error } when the code no longer matches the scan.
function applyChangesToText(text: string, changes: readonly FixChange[], capture?: CaptureChange): TextResult {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const located: { row: number; removed: number; added: string[] }[] = [];
  for (const change of changes) {
    const row = locateChange(lines, change);
    if (row === -1) return { error: `the code at line ${change.line} changed since the scan` };
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
): ApplyResult {
  const byFile = new Map<string, FixChange[]>();
  for (const change of fix.changes) {
    const changesOfFile = byFile.get(change.file) ?? [];
    changesOfFile.push(change);
    byFile.set(change.file, changesOfFile);
  }
  const updates: [string, string][] = [];
  for (const [file, changes] of byFile) {
    const result = applyChangesToText(readFile(file), changes, capture);
    if (result.error !== undefined) return { error: `${file}: ${result.error}` };
    updates.push([file, result.text]);
  }
  // Every file is checked before any is written, so a stale fix never leaves a half-applied change.
  for (const [file, text] of updates) writeFile(file, text);
  return { files: updates.map(([file]) => file) };
}

export { applyChangesToText, applyFix, locateChange };
