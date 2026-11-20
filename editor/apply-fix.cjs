'use strict';

// Applies a site fix to file text. A fix stores the exact original lines, so it is applied only where those lines
// still exist; an edit made since the scan moves or removes them and the fix then refuses instead of guessing.

// How far from the reported line the original lines may have moved because of edits elsewhere in the file.
const maxLineDrift = 200;

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

// Returns the new text, or { error } when the code no longer matches the scan.
function applyChangesToText(text, changes) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const located = [];
  for (const change of changes) {
    const row = locateChange(lines, change);
    if (row === -1) return { error: `the code at line ${change.line} changed since the scan` };
    if (isChangeApplied(lines, row, change)) continue;
    located.push({ row, removed: splitLines(change.before).length, added: splitLines(change.after) });
  }
  if (!located.length) return { error: 'already applied' };
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
  if (splitLines(currentText).join('\n') === splitLines(change.after).join('\n')) return { error: 'already applied' };
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
    if (result.error) return { error: `${file}: ${result.error}` };
    updates.push([file, result.text]);
  }
  // Every file is checked before any is written, so a stale fix never leaves a half-applied change.
  for (const [file, text] of updates) writeFile(file, text);
  return { files: updates.map(([file]) => file) };
}

module.exports = { applyChangesToText, applyFix, isChangeApplied, locateChange };
