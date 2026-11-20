'use strict';

// Applies a site fix to file text. A fix stores the exact original lines, so it is applied only where those lines
// still exist; an edit made since the scan moves or removes them and the fix then refuses instead of guessing.

// How far from the reported line the original lines may have moved because of edits elsewhere in the file.
const maxLineDrift = 200;
const alreadyApplied = 'already applied';

function splitLines(text) {
  return text.split(/\r?\n/);
}

// The row where `before` starts, nearest to the reported line, or -1.
function locateChange(lines, change) {
  const expected = splitLines(change.before);
  const reported = change.line - 1;
  const matchesAt = (row) => expected.every((line, offset) => lines[row + offset] === line);
  for (let distance = 0; distance <= maxLineDrift; distance++) {
    for (const row of distance ? [reported - distance, reported + distance] : [reported]) {
      if (row >= 0 && row + expected.length <= lines.length && matchesAt(row)) return row;
    }
  }
  return -1;
}

function blockAround(lines, row, block) {
  for (let start = Math.max(0, row - block.length); start <= row; start++) {
    if (block.every((line, offset) => lines[start + offset] === line)) return true;
  }
  return false;
}

// Two findings can share one change, such as the same missing index or the same batched helper. An insertion keeps
// the original lines, so the rewritten block around them means this change is already in the file.
function isChangeApplied(lines, row, change) {
  return blockAround(lines, row, splitLines(change.after));
}

// `import { a, b } from 'module';` on one line: the text before the names, the names, and the rest.
const namedImportPattern = /^(\s*import\s+(?:type\s+)?\{)([^}]*)(\}\s*from\s*(['"])([^'"]+)\4.*)$/;

function parseNamedImport(line) {
  const match = namedImportPattern.exec(line);
  if (!match) return;
  const names = match[2]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return { head: match[1], namesText: match[2], tail: match[3], module: match[5], names };
}

// Several fixes in one file often add names to the same import line. Once one has, the line no longer matches the
// others' original text, so a one-line named-import change is merged into that module's current import instead.
// Returns the row and merged line, { applied: true } when every name is already imported, or undefined.
function mergeNamedImport(lines, change) {
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
    const trailingSpace = /\s*$/.exec(current.namesText)[0];
    const keptNames = current.namesText.trimEnd().replace(/,$/, '');
    return { row, line: `${current.head}${keptNames}, ${added.join(', ')}${trailingSpace}${current.tail}` };
  }
}

// Returns the new text, or { error } when the code no longer matches the scan.
function applyChangesToText(text, changes) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const located = [];
  for (const change of changes) {
    const row = locateChange(lines, change);
    if (row === -1) {
      const merged = mergeNamedImport(lines, change);
      if (merged?.applied) continue;
      if (merged) {
        located.push({ row: merged.row, removed: 1, added: [merged.line] });
        continue;
      }
      return { error: `the code at line ${change.line} changed since the scan` };
    }
    if (isChangeApplied(lines, row, change)) continue;
    located.push({ row, removed: splitLines(change.before).length, added: splitLines(change.after) });
  }
  if (!located.length) return { error: alreadyApplied };
  located.sort((left, right) => right.row - left.row);
  for (let index = 1; index < located.length; index++) {
    if (located[index].row + located[index].removed > located[index - 1].row) return { error: 'overlapping changes' };
  }
  for (const { row, removed, added } of located) lines.splice(row, removed, ...added);
  return { text: lines.join(newline) };
}

// A change with `create: true` holds a whole new file. It refuses to overwrite a different existing file, and an
// identical one means the fix was already applied.
function createdFileText(change, currentText) {
  if (currentText === undefined) return { text: change.after };
  if (splitLines(currentText).join('\n') === splitLines(change.after).join('\n')) return { error: alreadyApplied };
  return { error: 'the file already exists with different content' };
}

function readIfExists(readFile, file) {
  try {
    return readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Groups a fix's changes by file and applies them through the given file accessors. `readFile` throws an ENOENT
// error (or returns undefined) for a missing file; `writeFile` creates the parent folders of a new file.
function applyFix(fix, { readFile, writeFile }) {
  const byFile = new Map();
  for (const change of fix.changes) {
    if (!byFile.has(change.file)) byFile.set(change.file, []);
    byFile.get(change.file).push(change);
  }
  const updates = [];
  for (const [file, changes] of byFile) {
    const created = changes.some((change) => change.create);
    if (created && changes.length > 1) return { error: `${file}: a new file cannot take other changes` };
    const currentText = readIfExists(readFile, file);
    if (!created && currentText === undefined) return { error: `${file}: the file no longer exists` };
    const result = created ? createdFileText(changes[0], currentText) : applyChangesToText(currentText, changes);
    // A file another fix already changed the same way, such as a shared batch helper, needs no write.
    if (result.error === alreadyApplied) continue;
    if (result.error) return { error: `${file}: ${result.error}` };
    updates.push([file, result.text]);
  }
  if (!updates.length) return { error: alreadyApplied };
  // Every file is checked before any is written, so a stale fix never leaves a half-applied change.
  for (const [file, text] of updates) writeFile(file, text);
  return { files: updates.map(([file]) => file) };
}

module.exports = { applyChangesToText, applyFix, isChangeApplied, locateChange };
