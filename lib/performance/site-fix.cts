// Builds a concrete rewrite of the flagged code for each finding. Builders see the parsed file and
// return text edits; this module applies them, keeps only fixes whose result still parses, and
// reports the changed lines.
import fs from 'node:fs';
import path from 'node:path';
import { lineStartsOf, nodeAtPosition, parseErrorCount, hunksFor, normalize, validFix } from '../shared/fix-hunks.cjs';
import { requireWithSyntax } from './compiler.cjs';
import {
  dropConflictingComments,
  rememberCommentRow,
  withWhyComment,
  withoutComment,
} from '../shared/fix-presentation.cjs';
import type { Node } from 'typescript';
import type * as Typescript from 'typescript';
import type {
  FileTarget,
  Finding,
  FindingFix,
  FixChange,
  FixResult,
  LoadedFile,
  SiteFixBuilder,
} from '../shared/types.cjs';

type SiteFixLoader = (filename: string) => LoadedFile | null;

interface FixOptions {
  comments?: boolean;
}

/** A builder module: its default export maps rule ids to the builders that rewrite them. */
interface SiteFixModule {
  default: Record<string, SiteFixBuilder>;
}

/**
 * Where a finding sits: the loaded file, the innermost node there and the offset; empty for
 * findings without a file.
 */
interface FindingLocation {
  entry?: LoadedFile;
  node?: Node;
  findingOffset?: number;
}

interface FileChanges {
  changes: FixChange[];
  commentRow?: number;
}

interface EditedFileInput {
  target: FileTarget;
  finding: Finding;
  entry: LoadedFile | undefined;
  findingOffset: number | undefined;
  result: FixResult;
  load: SiteFixLoader;
  comments: boolean;
}

const builderModules = [
  './site-fixes/sync-calls.cjs',
  './site-fixes/typeorm.cjs',
  './site-fixes/collections.cjs',
  './site-fixes/query-loops.cjs',
  './site-fixes/batch-loops.cjs',
  './site-fixes/error-handling.cjs',
  './site-fixes/streams.cjs',
  './site-fixes/small-rewrites.cjs',
  './site-fixes/query-shapes.cjs',
  './site-fixes/list-queries.cjs',
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
  './site-fixes/frontend-fixes.cjs',
  './site-fixes/backend-mastery-fixes.cjs',
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
  './site-fixes/transaction-escape.cjs',
  './site-fixes/json-parse.cjs',
  '../security/site-fixes/injection.cjs',
  '../security/site-fixes/request-forgery.cjs',
  '../security/site-fixes/auth-crypto.cjs',
  '../security/site-fixes/secret-comparison.cjs',
  '../security/site-fixes/exposure.cjs',
  '../security/site-fixes/error-responses.cjs',
  '../security/site-fixes/jwt.cjs',
  '../security/site-fixes/template-autoescape.cjs',
  '../security/site-fixes/frontend-security-fixes.cjs',
  '../security/site-fixes/backend-security-fixes.cjs',
];
// Hunks longer than this stop being a readable inline fix; the rule example is shown instead.
const maxHunkLines = 14;
// Edits closer than this many lines print as one hunk so the reader sees the code between them.
const hunkJoinDistance = 3;
// A created file, such as a migration, is shown whole; past this it is no longer a readable inline
// fix.
const maxCreatedFileLines = 40;

let builders: Map<string, SiteFixBuilder> | undefined;
function buildersByRule(): Map<string, SiteFixBuilder> {
  if (builders) return builders;
  const registered = new Map<string, SiteFixBuilder>();
  builders = registered;
  // Builders read the bundled TypeScript's nodes, even when the rules ran on the native compiler.
  const bundled: typeof Typescript = require('typescript');
  for (const modulePath of builderModules) {
    const loaded = requireWithSyntax<SiteFixModule>(require.resolve(modulePath), bundled);
    for (const [ruleId, build] of Object.entries(loaded.default)) registered.set(ruleId, build);
  }
  return registered;
}

const scriptKinds: Record<string, number> = {
  '.ts': 3,
  '.mts': 3,
  '.cts': 3,
  '.tsx': 4,
  '.js': 1,
  '.cjs': 1,
  '.mjs': 1,
  '.jsx': 2,
};

function createFileCache(): SiteFixLoader {
  const files = new Map<string, LoadedFile | null>();
  return function load(filename: string): LoadedFile | null {
    const absolute = path.resolve(filename);
    if (files.has(absolute)) return files.get(absolute) ?? null;
    let entry: LoadedFile | null = null;
    try {
      const text = fs.readFileSync(absolute, 'utf8');
      entry = { filename, absolute, text, lineStarts: lineStartsOf(text) };
      const scriptKind = scriptKinds[path.extname(absolute).toLowerCase()];
      if (scriptKind !== undefined) {
        const ts: typeof Typescript = require('typescript');
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

// Builder contract. `build({ finding, node, sourceFile, text, load })` returns `{ edits, note }`
// for the flagged file or `{ targets, note }` for several files, where each edit is `{ start, end,
// text }` in offsets of that file.
// `separateEdits` keeps nearby edits in separate hunks so several fixes can share a common
// insertion.
// - Flagged JS/TS file: `node` is the innermost node at the reported position and `sourceFile` its
// parsed file.
// - Any other flagged file (.prisma schema, .sql migration, ...): `node` and `sourceFile` are
// undefined and
//   `text` is the raw file text; edits are only bounds-checked, there is no parse check.
// - A finding without a file (live-database db-* rules): `node`, `sourceFile` and `text` are
// undefined, so the
//   builder must return `targets`.
// A target `{ file, create: true, text }` creates a new file, such as a migration. It is dropped
// when the file already exists with other content, and a JS/TS file must parse. It becomes the
// change
// `{ file, line: 1, before: '', after: text, create: true }`.
// `comments: false` leaves out the why-comment above the fixed statement. Builders see `comments`
// too: one that writes a comment specific to the site into its edits returns that text, unindented,
// as `comment`.
function buildFix(finding: Finding, load: SiteFixLoader, { comments = true }: FixOptions = {}): FindingFix | undefined {
  const build = buildersByRule().get(finding.ruleId);
  if (!build) return;
  const location = locateFinding(finding, load);
  if (!location) return;
  const { entry, node, findingOffset } = location;
  const result = build({ finding, node, sourceFile: entry?.sourceFile, text: entry?.text, load, comments });
  if (!result) return;
  const targets =
    result.targets ?? (entry && finding.file !== undefined ? [{ file: finding.file, edits: result.edits }] : []);
  let commentRow: number | undefined;
  const changes: FixChange[] = [];
  for (const target of targets) {
    if (typeof target?.file !== 'string') return;
    const targetChanges = target.create
      ? createdFileChanges(target, load)
      : editedFileChanges({ target, finding, entry, findingOffset, result, load, comments });
    if (!targetChanges) return;
    changes.push(...targetChanges.changes);
    if (targetChanges.commentRow !== undefined) commentRow = targetChanges.commentRow;
  }
  if (!changes.length || changes.every((change) => change.before === change.after)) return;
  const fix: FindingFix = {
    changes,
    ...(result.note && { note: result.note }),
    ...(result.requiresReview && { requiresReview: true }),
    ...(result.comment && { comment: result.comment }),
  };
  if (commentRow !== undefined && finding.file !== undefined) rememberCommentRow(fix, finding.file, commentRow);
  return fix;
}

// Returns undefined when the finding does not point at a usable position, and an empty location for
// file-less findings.
function locateFinding(finding: Finding, load: SiteFixLoader): FindingLocation | undefined {
  if (finding.file === undefined) return {};
  if (typeof finding.file !== 'string') return;
  const entry = load(finding.file);
  const { line, column } = finding;
  if (!entry || line === undefined || column === undefined || !(line >= 1 && line <= entry.lineStarts.length)) return;
  const findingOffset = entry.lineStarts[line - 1] + column - 1;
  if (!entry.sourceFile) return { entry, findingOffset };
  const node = nodeAtPosition(entry, findingOffset);
  if (!node) return;
  return { entry, node, findingOffset };
}

function createdFileChanges(target: FileTarget, load: SiteFixLoader): FileChanges | undefined {
  const change = createdFileChange(target, load);
  return change && { changes: [change] };
}

function editedFileChanges({
  target,
  finding,
  entry,
  findingOffset,
  result,
  load,
  comments,
}: EditedFileInput): FileChanges | undefined {
  const targetEntry = target.file === finding.file ? entry : load(target.file);
  if (!targetEntry || !Array.isArray(target.edits) || !validFix(targetEntry, target.edits)) return;
  // A builder that wrote its own comment into the edits gets no generic one.
  const commented = result.comment
    ? { edits: target.edits, comment: result.comment }
    : comments && entry && findingOffset !== undefined && targetEntry === entry
      ? withWhyComment({
          ruleId: finding.ruleId,
          entry,
          edits: target.edits,
          findingOffset,
          separateEdits: result.separateEdits,
        })
      : { edits: target.edits };
  const { comment, row }: { comment?: string; row?: number } = commented;
  const edits = commented.edits ?? target.edits;
  const changes: FixChange[] = [];
  for (const hunk of hunksFor(targetEntry, edits, result.separateEdits ? 0 : hunkJoinDistance)) {
    const codeAfter = withoutComment(hunk.after, comment);
    if (hunk.before.split('\n').length > maxHunkLines || codeAfter.split('\n').length > maxHunkLines) return;
    changes.push({ ...hunk, before: normalize(hunk.before), after: normalize(hunk.after) });
  }
  return { changes, commentRow: comment ? row : undefined };
}

function createdFileChange(target: FileTarget, load: SiteFixLoader): FixChange | undefined {
  if (typeof target.text !== 'string' || !target.text.trim()) return;
  const after = normalize(target.text);
  if (after.split('\n').length > maxCreatedFileLines) return;
  const existing = load(target.file);
  // An identical file is kept as a fix so applying it reports "already applied" rather than
  // vanishing.
  if (existing && normalize(existing.text) !== after) return;
  const scriptKind = scriptKinds[path.extname(target.file).toLowerCase()];
  if (scriptKind !== undefined && parseErrorCount({ absolute: path.resolve(target.file), scriptKind }, after)) return;
  return { file: target.file, line: 1, before: '', after, create: true };
}

function attachSiteFixes(findings: Finding[], options?: FixOptions): void {
  const load = createFileCache();
  for (const finding of findings) {
    if (finding.fix) continue;
    let fix: FindingFix | undefined;
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

export { attachSiteFixes, buildFix, createFileCache };
