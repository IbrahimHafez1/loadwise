'use strict';

function lineStartsOf(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

function lineOf(entry, offset) {
  let low = 0;
  let high = entry.lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (entry.lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

// The innermost node whose span starts at the reported position.
function innermostNodeAt(ts, sourceFile, offset) {
  let found;
  (function visit(node) {
    if (node.getStart(sourceFile) <= offset && offset < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  })(sourceFile);
  return found;
}

function nodeAtPosition(entry, offset) {
  return innermostNodeAt(require('typescript'), entry.sourceFile, offset);
}

function parseErrorCount(entry, text) {
  const ts = require('typescript');
  const reparsed = ts.createSourceFile(entry.absolute, text, ts.ScriptTarget.Latest, false, entry.scriptKind);
  return reparsed.parseDiagnostics.length;
}

function applyEdits(text, edits) {
  let result = text;
  const indexed = edits.map((edit, index) => ({ edit, index }));
  indexed.sort((left, right) => right.edit.start - left.edit.start || right.index - left.index);
  for (const { edit } of indexed) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function overlapping(edits) {
  const sorted = [...edits].sort((left, right) => left.start - right.start);
  return sorted.some((edit, index) => index > 0 && edit.start < sorted[index - 1].end);
}

// Groups edits into hunks and renders each as the original and rewritten lines. A why-comment insertion (`comment:
// true`) joins the hunk that holds its line, or forms its own, without widening any hunk, so leaving the comment out
// gives exactly the hunks of the code edits alone.
function hunksFor(entry, edits, joinDistance) {
  const sorted = [...edits].sort((left, right) => left.start - right.start);
  const groups = [];
  for (const edit of sorted) {
    if (edit.comment) continue;
    const firstRow = lineOf(entry, edit.start);
    const lastRow = lineOf(entry, Math.max(edit.start, edit.end - 1));
    const group = groups.at(-1);
    if (group && firstRow - group.lastRow <= joinDistance) {
      group.edits.push(edit);
      group.lastRow = Math.max(group.lastRow, lastRow);
    } else groups.push({ firstRow, lastRow, edits: [edit] });
  }
  for (const edit of sorted.filter((candidate) => candidate.comment)) {
    const row = lineOf(entry, edit.start);
    const group = groups.find(({ firstRow, lastRow }) => firstRow <= row && row <= lastRow);
    if (group) group.edits.push(edit);
    else groups.push({ firstRow: row, lastRow: row, edits: [edit] });
  }
  groups.sort((left, right) => left.firstRow - right.firstRow);
  return groups.map(({ firstRow, lastRow, edits: groupEdits }) => {
    const start = entry.lineStarts[firstRow];
    const end = lineEnd(entry, lastRow);
    const before = entry.text.slice(start, end);
    const shifted = groupEdits.map((edit) => ({ ...edit, start: edit.start - start, end: edit.end - start }));
    return { file: entry.filename, line: firstRow + 1, before, after: applyEdits(before, shifted) };
  });
}

// Offset just past the last character of the row, before its line break.
function lineEnd(entry, row) {
  const next = entry.lineStarts[row + 1];
  if (next === undefined) return entry.text.length;
  return entry.text[next - 2] === '\r' ? next - 2 : next - 1;
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

function validFix(entry, edits) {
  if (!edits?.length || overlapping(edits)) return false;
  if (edits.some((edit) => edit.start < 0 || edit.end > entry.text.length || edit.start > edit.end)) return false;
  if (!entry.sourceFile) return true;
  return parseErrorCount(entry, applyEdits(entry.text, edits)) <= entry.sourceFile.parseDiagnostics.length;
}

module.exports = {
  applyEdits,
  innermostNodeAt,
  lineStartsOf,
  nodeAtPosition,
  parseErrorCount,
  hunksFor,
  normalize,
  validFix,
};
