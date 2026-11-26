// Builds a concrete rewrite of the flagged code for each finding. Builders see the parsed file and
// return text edits; this module applies them, keeps only fixes whose result still parses, and
// reports the changed lines.
import fs from 'node:fs';
import path from 'node:path';
import * as bundled from 'typescript';
import { lineStartsOf, nodeAtPosition, parseErrorCount, hunksFor, normalize, validFix } from '../shared/fix-hunks.js';
import { withSyntax } from './compiler.js';
import {
  dropConflictingComments,
  rememberCommentRow,
  withWhyComment,
  withoutComment,
} from '../shared/fix-presentation.js';
import type { Node } from 'typescript';
import type {
  FileTarget,
  Finding,
  FindingFix,
  FixChange,
  FixResult,
  LoadedFile,
  SiteFixBuilder,
} from '../shared/types.js';

type SiteFixLoader = (filename: string) => LoadedFile | null;

interface FixOptions {
  comments?: boolean;
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

// Hunks longer than this stop being a readable inline fix; the rule example is shown instead.
const maxHunkLines = 14;
// Edits closer than this many lines print as one hunk so the reader sees the code between them.
const hunkJoinDistance = 3;
// A created file, such as a migration, is shown whole; past this it is no longer a readable inline
// fix.
const maxCreatedFileLines = 40;

type BuilderRegistryModule = { default: Record<string, SiteFixBuilder> };

const builderModuleLoaders: readonly (() => Promise<BuilderRegistryModule>)[] = [
  () => import('./site-fixes/sync-calls.js'),
  () => import('./site-fixes/typeorm.js'),
  () => import('./site-fixes/collections.js'),
  () => import('./site-fixes/query-loops.js'),
  () => import('./site-fixes/batch-loops.js'),
  () => import('./site-fixes/error-handling.js'),
  () => import('./site-fixes/streams.js'),
  () => import('./site-fixes/small-rewrites.js'),
  () => import('./site-fixes/query-shapes.js'),
  () => import('./site-fixes/list-queries.js'),
  () => import('./site-fixes/indexes.js'),
  () => import('./site-fixes/writes.js'),
  () => import('./site-fixes/service-loops.js'),
  () => import('./site-fixes/http-timeouts.js'),
  () => import('./site-fixes/literal-awaits.js'),
  () => import('./site-fixes/typeorm-updates.js'),
  () => import('./site-fixes/queue-loops.js'),
  () => import('./site-fixes/last-insert-id.js'),
  () => import('./site-fixes/workbook-decodes.js'),
  () => import('./site-fixes/upload-limits.js'),
  () => import('./site-fixes/frontend-fixes.js'),
  () => import('./site-fixes/backend-mastery-fixes.js'),
  () => import('./site-fixes/prisma-aggregates.js'),
  () => import('./site-fixes/transaction-io.js'),
  () => import('./site-fixes/pure-js-hashing.js'),
  () => import('./site-fixes/page-counts.js'),
  () => import('./site-fixes/redis-keys.js'),
  () => import('./site-fixes/promise-catch.js'),
  () => import('./site-fixes/delete-preflight.js'),
  () => import('./site-fixes/guard-queries.js'),
  () => import('./site-fixes/integrity.js'),
  () => import('./site-fixes/await-before-early-exit.js'),
  () => import('./site-fixes/migrations.js'),
  () => import('./site-fixes/database.js'),
  () => import('./site-fixes/transaction-escape.js'),
  () => import('./site-fixes/json-parse.js'),
  () => import('../security/site-fixes/injection.js'),
  () => import('../security/site-fixes/request-forgery.js'),
  () => import('../security/site-fixes/auth-crypto.js'),
  () => import('../security/site-fixes/secret-comparison.js'),
  () => import('../security/site-fixes/exposure.js'),
  () => import('../security/site-fixes/error-responses.js'),
  () => import('../security/site-fixes/jwt.js'),
  () => import('../security/site-fixes/template-autoescape.js'),
  () => import('../security/site-fixes/frontend-security-fixes.js'),
  () => import('../security/site-fixes/backend-security-fixes.js'),
  () => import('../security/site-fixes/files.js'),
];

let builders: Map<string, SiteFixBuilder> | undefined;
let buildersPromise: Promise<Map<string, SiteFixBuilder>> | undefined;

/**
 * Lazily imports all performance and security site-fix registries on first fix generation or
 * application so clean scans pay zero module-load cost.
 */
async function loadBuilders(): Promise<Map<string, SiteFixBuilder>> {
  if (builders) return builders;
  buildersPromise ??= Promise.all(builderModuleLoaders.map((load) => load())).then((modules) => {
    const registered = new Map<string, SiteFixBuilder>();
    for (const mod of modules) {
      for (const [ruleId, build] of Object.entries(mod.default)) registered.set(ruleId, build);
    }
    builders = registered;
    return registered;
  });
  return buildersPromise;
}

function buildersByRule(): Map<string, SiteFixBuilder> {
  if (!builders) throw new Error('Site-fix builders are not loaded; await loadBuilders() first.');
  return builders;
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
        entry.sourceFile = bundled.createSourceFile(absolute, text, bundled.ScriptTarget.Latest, true, scriptKind);
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
  const result = withSyntax(bundled, () =>
    build({ finding, node, sourceFile: entry?.sourceFile, text: entry?.text, load, comments }),
  );
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
export { loadBuilders };
