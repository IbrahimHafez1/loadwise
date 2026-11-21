'use strict';

// Builds a concrete rewrite of the flagged code for each finding. Builders see the parsed file and return text
// edits; this module applies them, keeps only fixes whose result still parses, and reports the changed lines.
const fs = require('node:fs');
const path = require('node:path');
const {
  lineStartsOf,
  nodeAtPosition,
  parseErrorCount,
  hunksFor,
  normalize,
  validFix,
} = require('../shared/fix-hunks.cjs');
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
  './site-fixes/last-insert-id.cjs',
  './site-fixes/workbook-decodes.cjs',
  './site-fixes/upload-limits.cjs',
  './site-fixes/prisma-aggregates.cjs',
  './site-fixes/transaction-io.cjs',
  './site-fixes/pure-js-hashing.cjs',
  './site-fixes/page-counts.cjs',
  './site-fixes/redis-keys.cjs',
  './site-fixes/promise-catch.cjs',
  './site-fixes/delete-preflight.cjs',
  './site-fixes/guard-queries.cjs',
  './site-fixes/integrity.cjs',
  './site-fixes/await-before-early-exit.cjs',
  './site-fixes/migrations.cjs',
  './site-fixes/database.cjs',
  '../security/site-fixes/injection.cjs',
  '../security/site-fixes/request-forgery.cjs',
  '../security/site-fixes/auth-crypto.cjs',
  '../security/site-fixes/secret-comparison.cjs',
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

// Builder contract. `build({ finding, node, sourceFile, text, load })` returns `{ edits, note }` for the flagged file
// or `{ targets, note }` for several files, where each edit is `{ start, end, text }` in offsets of that file.
// `separateEdits` keeps nearby edits in separate hunks so several fixes can share a common insertion.
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
      node = nodeAtPosition(entry, entry.lineStarts[finding.line - 1] + finding.column - 1);
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
    for (const hunk of hunksFor(targetEntry, target.edits, result.separateEdits ? 0 : hunkJoinDistance)) {
      if (hunk.before.split('\n').length > maxHunkLines || hunk.after.split('\n').length > maxHunkLines) return;
      changes.push({ ...hunk, before: normalize(hunk.before), after: normalize(hunk.after) });
    }
  }
  if (!changes.length || changes.every((change) => change.before === change.after)) return;
  return { changes, ...(result.note && { note: result.note }), ...(result.requiresReview && { requiresReview: true }) };
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
