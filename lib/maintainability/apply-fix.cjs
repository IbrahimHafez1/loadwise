'use strict';

// Applies a site fix to file text. A fix stores the exact original lines, so it is applied only where those lines
// still exist; an edit made since the scan moves or removes them and the fix then refuses instead of guessing.

const { isChangeApplied, locateChange } = require('../../editor/apply-fix.cjs');

function splitLines(text) {
  return text.split(/\r?\n/);
}

// Returns the new text, or { error } when the code no longer matches the scan.
function applyChangesToText(text, changes, capture) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const located = [];
  for (const change of changes) {
    const row = locateChange(lines, change);
    if (row === -1) return { error: `the code at line ${change.line} changed since the scan` };
    const after = splitLines(change.after);
    // An added import keeps the original lines, so look for the rewritten block before applying it again.
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
function applyFix(fix, { readFile, writeFile }, capture) {
  const byFile = new Map();
  for (const change of fix.changes) {
    if (!byFile.has(change.file)) byFile.set(change.file, []);
    byFile.get(change.file).push(change);
  }
  const updates = [];
  for (const [file, changes] of byFile) {
    const result = applyChangesToText(readFile(file), changes, capture);
    if (result.error) return { error: `${file}: ${result.error}` };
    updates.push([file, result.text]);
  }
  // Every file is checked before any is written, so a stale fix never leaves a half-applied change.
  for (const [file, text] of updates) writeFile(file, text);
  return { files: updates.map(([file]) => file) };
}

module.exports = { applyChangesToText, applyFix, locateChange };
