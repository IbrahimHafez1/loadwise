'use strict';

// Builds a concrete rewrite of the flagged code for each finding. Builders see the parsed file and return text
// edits; this module applies them, keeps only fixes whose result still parses, and reports the changed lines.
const fs = require('node:fs');
const path = require('node:path');
const { lineStartsOf, nodeAtPosition, hunksFor, normalize, validFix } = require('../shared/fix-hunks.cjs');
const {
  dropConflictingComments,
  rememberCommentRow,
  withWhyComment,
  withoutComment,
} = require('../shared/fix-presentation.cjs');

const builderModules = [
  './site-fixes/large-module.cjs',
  './site-fixes/control-flow.cjs',
  './site-fixes/branches.cjs',
  './site-fixes/parameters.cjs',
  './site-fixes/duplicates.cjs',
  './site-fixes/cycles.cjs',
];
// Hunks longer than this stop being a readable inline fix; the rule example is shown instead.
const maxHunkLines = 14;
const maxReviewedDuplicateLines = 30;
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
  function load(filename) {
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
  }
  load.projectRoot = path.resolve(root);
  return load;
}

function reviewedDuplicateRemoval(finding, result, hunk, codeAfter) {
  return (
    result.requiresReview &&
    finding.ruleId === 'duplicate-implementation' &&
    (result.createdModule || !codeAfter.includes('\n')) &&
    codeAfter.length < hunk.before.length
  );
}

function originalLineLimit(result, edits) {
  // An extracted declaration appears in full in the created module. A guard can consume one trailing jump.
  if (result.createdModule) return result.createdModule.text.split('\n').length;
  return maxHunkLines + (edits.some((edit) => edit.removesTrailingJump) ? 1 : 0);
}

// `comments: false` leaves out the why-comment above the fixed statement.
function buildFix(finding, load, { comments = true } = {}) {
  const build = buildersByRule().get(finding.ruleId);
  if (!build || typeof finding.file !== 'string') return;
  const entry = load(finding.file);
  if (!entry?.sourceFile || !(finding.line >= 1 && finding.line <= entry.lineStarts.length)) return;
  const offset = entry.lineStarts[finding.line - 1] + finding.column - 1;
  const node = nodeAtPosition(entry, offset);
  if (!node) return;
  const result = build({ finding, node, offset, sourceFile: entry.sourceFile, text: entry.text, load });
  if (!result) return;
  let commentRow;
  const changes = [];
  for (const target of result.targets ?? [{ file: finding.file, edits: result.edits }]) {
    const targetEntry = target.file === finding.file ? entry : load(target.file);
    if (!targetEntry || !validFix(targetEntry, target.edits)) return;
    const maxBeforeLines = originalLineLimit(result, target.edits);
    const { edits, comment, row } =
      comments && targetEntry === entry
        ? withWhyComment({ ruleId: finding.ruleId, entry, edits: target.edits, findingOffset: offset })
        : { edits: target.edits };
    if (comment) commentRow = row;
    for (const hunk of hunksFor(targetEntry, edits, hunkJoinDistance)) {
      const codeAfter = withoutComment(hunk.after, comment);
      const reviewedRemoval = reviewedDuplicateRemoval(finding, result, hunk, codeAfter);
      if (
        hunk.before.split('\n').length > (reviewedRemoval ? maxReviewedDuplicateLines : maxBeforeLines) ||
        codeAfter.split('\n').length > maxHunkLines
      )
        return;
      changes.push({ ...hunk, before: normalize(hunk.before), after: normalize(hunk.after) });
    }
  }
  if (!changes.length || changes.every((change) => change.before === change.after)) return;
  if (result.createdModule) {
    const { file, text } = result.createdModule;
    changes.push({ file, line: 1, before: '', after: text, create: true });
  }
  const fix = {
    changes,
    ...(result.note && { note: result.note }),
    ...(result.requiresReview && { requiresReview: true }),
  };
  if (commentRow !== undefined) rememberCommentRow(fix, finding.file, commentRow);
  return fix;
}

function attachSiteFixes(findings, root, options) {
  const load = createFileCache(root);
  for (const finding of findings) {
    if (finding.fix) continue;
    let fix;
    try {
      fix = buildFix(finding, load, options);
    } catch {
      // A builder bug must never hide the finding itself.
      fix = undefined;
    }
    if (fix) finding.fix = fix;
  }
  dropConflictingComments(findings);
}

module.exports = { attachSiteFixes, buildFix, createFileCache };
