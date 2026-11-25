import type { FindingFix, FixChange } from '../lib/shared/types.js';
// Applies a site fix to file text. A fix stores the exact original lines, so it is applied only
// where those lines still exist; an edit made since the scan moves or removes them and the fix then
// refuses instead of guessing.

// How far from the reported line the original lines may have moved because of edits elsewhere in
// the file.
const maxLineDrift = 200;
const alreadyApplied = 'already applied';

/** Either the new text or the reason the fix was refused. */
export type TextResult = { text: string; error?: undefined } | { text?: undefined; error: string };

/** Either the files that were written or the reason the fix was refused. */
export type ApplyResult = { files: string[]; error?: undefined } | { files?: undefined; error: string };

export interface ApplyOptions {
  /** Refuse unless every change is at its reported line. */
  exactLocation?: boolean;
  /** Receives each change as it was applied, with the lines it really replaced. */
  capture?: (change: FixChange) => void;
}

/**
 * The file accessors `applyFix` works through; `readFile` throws ENOENT or returns undefined for a
 * missing file.
 */
export interface FileAccess {
  readFile(file: string): string | undefined;
  writeFile(file: string, text: string): void;
}

interface NamedImport {
  head: string;
  namesText: string;
  tail: string;
  module: string;
  names: string[];
}

type MergedImport =
  { applied: true; row?: undefined; line?: undefined } | { applied?: undefined; row: number; line: string };

interface LocatedChange {
  row: number;
  removed: number;
  added: string[];
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// Prefer the reported row. After a shift, only a unique nearby match identifies the intended edit.
function locateChange(lines: readonly string[], change: FixChange): number {
  const expected = splitLines(change.before);
  const reported = change.line - 1;
  const matchesAt = (row: number) => expected.every((line, offset) => lines[row + offset] === line);
  if (matchesAt(reported)) return reported;
  const last = Math.min(lines.length - expected.length, reported + maxLineDrift);
  let match = -1;
  for (let row = Math.max(0, reported - maxLineDrift); row <= last; row++) {
    if (!matchesAt(row)) continue;
    if (match !== -1) return -1;
    match = row;
  }
  return match;
}

// Two findings can share one change, such as the same missing index or the same batched helper. An
// insertion keeps the original lines, so the rewritten block around them means this change is
// already in the file.
function isChangeApplied(lines: readonly string[], row: number, change: FixChange): boolean {
  const beforeLength = splitLines(change.before).length;
  const after = splitLines(change.after);
  for (let start = Math.max(0, row + beforeLength - after.length); start <= row; start++) {
    if (after.every((line, offset) => lines[start + offset] === line)) return true;
  }
  return false;
}

// `import { a, b } from 'module';` on one line: the text before the names, the names, and the rest.
const namedImportPattern = /^(\s*import\s+(?:type\s+)?\{)([^}]*)(\}\s*from\s*(['"])([^'"]+)\4.*)$/;

function parseNamedImport(line: string): NamedImport | undefined {
  const match = namedImportPattern.exec(line);
  if (!match) return;
  const names = match[2]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return { head: match[1], namesText: match[2], tail: match[3], module: match[5], names };
}

// Several fixes in one file often add names to the same import line. Once one has, the line no
// longer matches the others' original text, so a one-line named-import change is merged into that
// module's current import instead. Returns the row and merged line, { applied: true } when every
// name is already imported, or undefined.
function mergeNamedImport(lines: readonly string[], change: FixChange): MergedImport | undefined {
  const [before, after] = [change.before, change.after].map(splitLines);
  if (before.length !== 1 || after.length !== 1) return;
  const original = parseNamedImport(before[0]);
  const wanted = parseNamedImport(after[0]);
  if (!original || !wanted || original.module !== wanted.module || original.head.trim() !== wanted.head.trim()) return;
  for (const [row, line] of lines.entries()) {
    const current = parseNamedImport(line);
    if (current?.module !== wanted.module || current.head.trim() !== wanted.head.trim()) continue;
    if (!original.names.every((name) => current.names.includes(name))) continue;
    const added = wanted.names.filter((name) => !current.names.includes(name));
    if (!added.length) return { applied: true };
    const trailingSpace = /\s*$/.exec(current.namesText)?.[0] ?? '';
    const keptNames = current.namesText.trimEnd().replace(/,$/, '');
    return { row, line: `${current.head}${keptNames}, ${added.join(', ')}${trailingSpace}${current.tail}` };
  }
}

// Returns the new text, or { error } when the code no longer matches the scan.
function applyChangesToText(
  text: string,
  changes: readonly FixChange[],
  { exactLocation = false, capture }: ApplyOptions = {},
): TextResult {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const located: LocatedChange[] = [];
  for (const change of changes) {
    const row = locateChange(lines, change);
    if (exactLocation && row !== change.line - 1)
      return { error: `the code at line ${change.line} changed since the scan` };
    if (row === -1) {
      const merged = mergeNamedImport(lines, change);
      if (merged?.applied) continue;
      if (merged) {
        located.push({ row: merged.row, removed: 1, added: [merged.line] });
        continue;
      }
      return { error: `the code at line ${change.line} changed since the scan` };
    }
    if (isChangeApplied(lines, row, change)) {
      if (exactLocation) return { error: `the change at line ${change.line} is already in the file` };
      continue;
    }
    located.push({ row, removed: splitLines(change.before).length, added: splitLines(change.after) });
  }
  if (!located.length) return { error: alreadyApplied };
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

// A change with `create: true` holds a whole new file. It refuses to overwrite a different existing
// file, and an identical one means the fix was already applied.
function createdFileText(change: FixChange, currentText: string | undefined): TextResult {
  if (currentText === undefined) return { text: change.after };
  if (splitLines(currentText).join('\n') === splitLines(change.after).join('\n')) return { error: alreadyApplied };
  return { error: 'the file already exists with different content' };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function readIfExists(readFile: FileAccess['readFile'], file: string): string | undefined {
  try {
    return readFile(file);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

// Groups a fix's changes by file and applies them through the given file accessors. `readFile`
// throws an ENOENT error (or returns undefined) for a missing file; `writeFile` creates the parent
// folders of a new file.
function applyFix(
  fix: Pick<FindingFix, 'changes'>,
  { readFile, writeFile }: FileAccess,
  options?: ApplyOptions,
): ApplyResult {
  const byFile = new Map<string, FixChange[]>();
  for (const change of fix.changes) {
    const fileChanges = byFile.get(change.file);
    if (fileChanges) fileChanges.push(change);
    else byFile.set(change.file, [change]);
  }
  const updates: [string, string][] = [];
  for (const [file, changes] of byFile) {
    const created = changes.some((change) => change.create);
    if (created && changes.length > 1) return { error: `${file}: a new file cannot take other changes` };
    const currentText = readIfExists(readFile, file);
    let result: TextResult;
    if (created) result = createdFileText(changes[0], currentText);
    else if (currentText === undefined) return { error: `${file}: the file no longer exists` };
    else result = applyChangesToText(currentText, changes, options);
    // A file another fix already changed the same way, such as a shared batch helper, needs no
    // write.
    if (result.error === alreadyApplied && !options?.exactLocation) continue;
    if (result.text === undefined) return { error: `${file}: ${result.error}` };
    if (created) options?.capture?.(changes[0]);
    updates.push([file, result.text]);
  }
  if (!updates.length) return { error: alreadyApplied };
  // Every file is checked before any is written, so a stale fix never leaves a half-applied change.
  for (const [file, text] of updates) writeFile(file, text);
  return { files: updates.map(([file]) => file) };
}

export { applyChangesToText, applyFix, isChangeApplied, locateChange };
