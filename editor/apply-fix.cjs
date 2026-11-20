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

// Returns the new text, or { error } when the code no longer matches the scan.
function applyChangesToText(text, changes) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const located = [];
  for (const change of changes) {
    const row = locateChange(lines, change);
    if (row === -1) return { error: `the code at line ${change.line} changed since the scan` };
    const after = splitLines(change.after);
    // Two findings can share one fix, such as the same missing index. An insertion keeps the original lines, so
    // look for the rewritten block around them to avoid inserting it twice.
    if (blockAround(lines, row, after)) return { error: 'already applied' };
    located.push({ row, removed: splitLines(change.before).length, added: after });
  }
  located.sort((left, right) => right.row - left.row);
  for (let index = 1; index < located.length; index++) {
    if (located[index].row + located[index].removed > located[index - 1].row) return { error: 'overlapping changes' };
  }
  for (const { row, removed, added } of located) lines.splice(row, removed, ...added);
  return { text: lines.join(newline) };
}

// Groups a fix's changes by file and applies them through the given file accessors.
function applyFix(fix, { readFile, writeFile }) {
  const byFile = new Map();
  for (const change of fix.changes) {
    if (!byFile.has(change.file)) byFile.set(change.file, []);
    byFile.get(change.file).push(change);
  }
  const updates = [];
  for (const [file, changes] of byFile) {
    const result = applyChangesToText(readFile(file), changes);
    if (result.error) return { error: `${file}: ${result.error}` };
    updates.push([file, result.text]);
  }
  // Every file is checked before any is written, so a stale fix never leaves a half-applied change.
  for (const [file, text] of updates) writeFile(file, text);
  return { files: updates.map(([file]) => file) };
}

module.exports = { applyChangesToText, applyFix, locateChange };
