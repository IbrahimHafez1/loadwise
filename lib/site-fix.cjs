'use strict';

// Builds a concrete rewrite of the flagged code for each finding. Builders see the parsed file and return text
// edits; this module applies them, keeps only fixes whose result still parses, and reports the changed lines.
const fs = require('node:fs');
const path = require('node:path');

const builderModules = [
  './site-fixes/control-flow.cjs',
  './site-fixes/branches.cjs',
  './site-fixes/duplicates.cjs',
  './site-fixes/cycles.cjs',
];
// Hunks longer than this stop being a readable inline fix; the rule example is shown instead.
const maxHunkLines = 14;
// Edits closer than this many lines print as one hunk so the reader sees the code between them.
const hunkJoinDistance = 3;

let builders;
function buildersByRule() {
  if (builders) return builders;
  builders = new Map();
  for (const modulePath of builderModules) {
    for (const [ruleId, build] of Object.entries(require(modulePath))) builders.set(ruleId, build);
  }
  return builders;
}

const scriptKinds = { '.ts': 3, '.mts': 3, '.cts': 3, '.tsx': 4, '.js': 1, '.cjs': 1, '.mjs': 1, '.jsx': 2 };

// Loads project-relative files once. Findings and fix changes name files relative to the scanned root.
function createFileCache(root) {
  const files = new Map();
  return function load(filename) {
    if (files.has(filename)) return files.get(filename);
    let entry = null;
    try {
      const absolute = path.resolve(root, filename);
      // The scanner strips a byte order mark before reporting positions, so offsets here must match.
      const text = fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '');
      entry = { filename, absolute, text, lineStarts: lineStartsOf(text) };
      const scriptKind = scriptKinds[path.extname(absolute).toLowerCase()];
      if (scriptKind !== undefined) {
        const ts = require('typescript');
        entry.sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, scriptKind);
        entry.scriptKind = scriptKind;
      }
    } catch {
      entry = null;
    }
    files.set(filename, entry);
    return entry;
  };
}

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
function nodeAtPosition(entry, offset) {
  const ts = require('typescript');
  let found;
  (function visit(node) {
    if (node.getStart(entry.sourceFile) <= offset && offset < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  })(entry.sourceFile);
  return found;
}

function parseErrorCount(entry, text) {
  const ts = require('typescript');
  const reparsed = ts.createSourceFile(entry.absolute, text, ts.ScriptTarget.Latest, false, entry.scriptKind);
  return reparsed.parseDiagnostics.length;
}

function applyEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function overlapping(edits) {
  const sorted = [...edits].sort((left, right) => left.start - right.start);
  return sorted.some((edit, index) => index > 0 && edit.start < sorted[index - 1].end);
}

// Offset just past the last character of the row, before its line break.
function lineEnd(entry, row) {
  const next = entry.lineStarts[row + 1];
  if (next === undefined) return entry.text.length;
  return entry.text[next - 2] === '\r' ? next - 2 : next - 1;
}

// Groups edits into hunks and renders each as the original and rewritten lines.
function hunksFor(entry, edits) {
  const sorted = [...edits].sort((left, right) => left.start - right.start);
  const groups = [];
  for (const edit of sorted) {
    const firstRow = lineOf(entry, edit.start);
    const lastRow = lineOf(entry, Math.max(edit.start, edit.end - 1));
    const group = groups.at(-1);
    if (group && firstRow - group.lastRow <= hunkJoinDistance) {
      group.edits.push(edit);
      group.lastRow = Math.max(group.lastRow, lastRow);
    } else groups.push({ firstRow, lastRow, edits: [edit] });
  }
  return groups.map(({ firstRow, lastRow, edits: groupEdits }) => {
    const start = entry.lineStarts[firstRow];
    const end = lineEnd(entry, lastRow);
    const before = entry.text.slice(start, end);
    const shifted = groupEdits.map((edit) => ({ ...edit, start: edit.start - start, end: edit.end - start }));
    return { file: entry.filename, line: firstRow + 1, before, after: applyEdits(before, shifted) };
  });
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

// A fix may never introduce a syntax error; the scanner rejects unparsable files outright.
function validFix(entry, edits) {
  if (!edits?.length || overlapping(edits)) return false;
  if (edits.some((edit) => edit.start < 0 || edit.end > entry.text.length || edit.start > edit.end)) return false;
  if (!entry.sourceFile) return true;
  return parseErrorCount(entry, applyEdits(entry.text, edits)) <= entry.sourceFile.parseDiagnostics.length;
}

function buildFix(finding, load) {
  const build = buildersByRule().get(finding.ruleId);
  if (!build || typeof finding.file !== 'string') return;
  const entry = load(finding.file);
  if (!entry?.sourceFile || !(finding.line >= 1 && finding.line <= entry.lineStarts.length)) return;
  const offset = entry.lineStarts[finding.line - 1] + finding.column - 1;
  const node = nodeAtPosition(entry, offset);
  if (!node) return;
  const result = build({ finding, node, offset, sourceFile: entry.sourceFile, text: entry.text, load });
  if (!result) return;
  const changes = [];
  for (const target of result.targets ?? [{ file: finding.file, edits: result.edits }]) {
    const targetEntry = target.file === finding.file ? entry : load(target.file);
    if (!targetEntry || !validFix(targetEntry, target.edits)) return;
    for (const hunk of hunksFor(targetEntry, target.edits)) {
      if (hunk.before.split('\n').length > maxHunkLines || hunk.after.split('\n').length > maxHunkLines) return;
      changes.push({ ...hunk, before: normalize(hunk.before), after: normalize(hunk.after) });
    }
  }
  if (!changes.length || changes.every((change) => change.before === change.after)) return;
  return { changes, ...(result.note && { note: result.note }) };
}

function attachSiteFixes(findings, root) {
  const load = createFileCache(root);
  for (const finding of findings) {
    if (finding.fix) continue;
    let fix;
    try {
      fix = buildFix(finding, load);
    } catch {
      // A builder bug must never hide the finding itself.
      fix = undefined;
    }
    if (fix) finding.fix = fix;
  }
}

module.exports = { attachSiteFixes, buildFix, createFileCache };
