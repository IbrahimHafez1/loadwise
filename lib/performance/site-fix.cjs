'use strict';

// Builds a concrete rewrite of the flagged code for each finding. Builders see the parsed file and return text
// edits; this module applies them, keeps only fixes whose result still parses, and reports the changed lines.
const fs = require('node:fs');
const path = require('node:path');
const { requireWithSyntax } = require('./compiler.cjs');

const builderModules = [
  './site-fixes/sync-calls.cjs',
  './site-fixes/typeorm.cjs',
  './site-fixes/collections.cjs',
  './site-fixes/query-loops.cjs',
  './site-fixes/indexes.cjs',
  './site-fixes/writes.cjs',
  './site-fixes/service-loops.cjs',
  './site-fixes/http-timeouts.cjs',
  './site-fixes/literal-awaits.cjs',
  './site-fixes/typeorm-updates.cjs',
  './site-fixes/queue-loops.cjs',
  './site-fixes/upload-limits.cjs',
  './site-fixes/prisma-aggregates.cjs',
  './site-fixes/transaction-io.cjs',
  './site-fixes/pure-js-hashing.cjs',
  './site-fixes/page-counts.cjs',
  './site-fixes/redis-keys.cjs',
  './site-fixes/guard-queries.cjs',
  './site-fixes/integrity.cjs',
  './site-fixes/migrations.cjs',
  './site-fixes/database.cjs',
  '../security/site-fixes/injection.cjs',
  '../security/site-fixes/request-forgery.cjs',
  '../security/site-fixes/auth-crypto.cjs',
  '../security/site-fixes/exposure.cjs',
];
// Hunks longer than this stop being a readable inline fix; the rule example is shown instead.
const maxHunkLines = 14;
// Edits closer than this many lines print as one hunk so the reader sees the code between them.
const hunkJoinDistance = 3;
// A created file, such as a migration, is shown whole; past this it is no longer a readable inline fix.
const maxCreatedFileLines = 40;

let builders;
function buildersByRule() {
  if (builders) return builders;
  builders = new Map();
  // Builders read the bundled TypeScript's nodes, even when the rules ran on the native compiler.
  const bundled = require('typescript');
  for (const modulePath of builderModules) {
    const loaded = requireWithSyntax(require.resolve(modulePath), bundled);
    for (const [ruleId, build] of Object.entries(loaded)) builders.set(ruleId, build);
  }
  return builders;
}

const scriptKinds = { '.ts': 3, '.mts': 3, '.cts': 3, '.tsx': 4, '.js': 1, '.cjs': 1, '.mjs': 1, '.jsx': 2 };

function createFileCache() {
  const files = new Map();
  return function load(filename) {
    const absolute = path.resolve(filename);
    if (files.has(absolute)) return files.get(absolute);
    let entry = null;
    try {
      const text = fs.readFileSync(absolute, 'utf8');
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
    files.set(absolute, entry);
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
function nodeAtPosition(entry, line, column) {
  const offset = entry.lineStarts[line - 1] + column - 1;
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
  if (!edits.length || overlapping(edits)) return false;
  if (edits.some((edit) => edit.start < 0 || edit.end > entry.text.length || edit.start > edit.end)) return false;
  if (!entry.sourceFile) return true;
  return parseErrorCount(entry, applyEdits(entry.text, edits)) <= entry.sourceFile.parseDiagnostics.length;
}

// Builder contract. `build({ finding, node, sourceFile, text, load })` returns `{ edits, note }` for the flagged file
// or `{ targets, note }` for several files, where each edit is `{ start, end, text }` in offsets of that file.
// - Flagged JS/TS file: `node` is the innermost node at the reported position and `sourceFile` its parsed file.
// - Any other flagged file (.prisma schema, .sql migration, ...): `node` and `sourceFile` are undefined and
//   `text` is the raw file text; edits are only bounds-checked, there is no parse check.
// - A finding without a file (live-database db-* rules): `node`, `sourceFile` and `text` are undefined, so the
//   builder must return `targets`.
// A target `{ file, create: true, text }` creates a new file, such as a migration. It is dropped when the file
// already exists with other content, and a JS/TS file must parse. It becomes the change
// `{ file, line: 1, before: '', after: text, create: true }`.
function buildFix(finding, load) {
  const build = buildersByRule().get(finding.ruleId);
  if (!build) return;
  let entry;
  let node;
  if (finding.file !== undefined) {
    if (typeof finding.file !== 'string') return;
    entry = load(finding.file);
    if (!entry || !(finding.line >= 1 && finding.line <= entry.lineStarts.length)) return;
    if (entry.sourceFile) {
      node = nodeAtPosition(entry, finding.line, finding.column);
      if (!node) return;
    }
  }
  const result = build({ finding, node, sourceFile: entry?.sourceFile, text: entry?.text, load });
  if (!result) return;
  const targets = result.targets ?? (entry ? [{ file: finding.file, edits: result.edits }] : []);
  const changes = [];
  for (const target of targets) {
    if (typeof target?.file !== 'string') return;
    if (target.create) {
      const change = createdFileChange(target, load);
      if (!change) return;
      changes.push(change);
      continue;
    }
    const targetEntry = target.file === finding.file ? entry : load(target.file);
    if (!targetEntry || !Array.isArray(target.edits) || !validFix(targetEntry, target.edits)) return;
    for (const hunk of hunksFor(targetEntry, target.edits)) {
      if (hunk.before.split('\n').length > maxHunkLines || hunk.after.split('\n').length > maxHunkLines) return;
      changes.push({ ...hunk, before: normalize(hunk.before), after: normalize(hunk.after) });
    }
  }
  if (!changes.length || changes.every((change) => change.before === change.after)) return;
  return { changes, ...(result.note && { note: result.note }) };
}

function createdFileChange(target, load) {
  if (typeof target.text !== 'string' || !target.text.trim()) return;
  const after = normalize(target.text);
  if (after.split('\n').length > maxCreatedFileLines) return;
  const existing = load(target.file);
  // An identical file is kept as a fix so applying it reports "already applied" rather than vanishing.
  if (existing && normalize(existing.text) !== after) return;
  const scriptKind = scriptKinds[path.extname(target.file).toLowerCase()];
  if (scriptKind !== undefined && parseErrorCount({ absolute: path.resolve(target.file), scriptKind }, after)) return;
  return { file: target.file, line: 1, before: '', after, create: true };
}

function attachSiteFixes(findings) {
  const load = createFileCache();
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
