// Builds a concrete rewrite of the flagged code for each finding. Builders see the parsed file and
// return text edits; this module applies them, keeps only fixes whose result still parses, and
// reports the changed lines.
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { lineStartsOf, nodeAtPosition, hunksFor, normalize, validFix } from '../shared/fix-hunks.js';
import {
  dropConflictingComments,
  rememberCommentRow,
  withWhyComment,
  withoutComment,
} from '../shared/fix-presentation.js';
import largeModule from './site-fixes/large-module.js';
import controlFlow from './site-fixes/control-flow.js';
import branches from './site-fixes/branches.js';
import parameters from './site-fixes/parameters.js';
import duplicates from './site-fixes/duplicates.js';
import cycles from './site-fixes/cycles.js';
import exportsFix from './site-fixes/exports.js';
import unusedBindings from './site-fixes/unused-bindings.js';
import strayConsole from './site-fixes/stray-console.js';
import deprecatedApis from './site-fixes/deprecated-apis.js';
import type { Finding, FindingFix, FixChange, LoadedFile, SiteFixBuilder } from '../shared/types.js';
import type { ModuleCreatingFix } from './types/created-module.js';
import type { JumpRemovingEdit } from './types/site-fix-edits.js';
import type { ProjectLoad, ProjectSiteFixInput } from './types/site-fix-loader.js';

interface SiteFixOptions {
  /**
   * What the scan learned about each file's identifiers, so fixes need not read the files again.
   */
  identifierIndex?: Map<string, string>;
  /** `false` leaves out the why-comment above the fixed statement. */
  comments?: boolean;
}

// The registry also passes the offset of the finding, which the shared input does not declare.
type BuilderInput = ProjectSiteFixInput & { offset: number };

const builderRegistries: readonly Record<string, SiteFixBuilder>[] = [
  largeModule,
  controlFlow,
  branches,
  parameters,
  duplicates,
  cycles,
  exportsFix,
  unusedBindings,
  strayConsole,
  deprecatedApis,
];
// Hunks longer than this stop being a readable inline fix; the rule example is shown instead.
const maxHunkLines = 14;
const maxReviewedDuplicateLines = 30;
// Edits closer than this many lines print as one hunk so the reader sees the code between them.
const hunkJoinDistance = 3;

let builders: Map<string, SiteFixBuilder> | undefined;
function buildersByRule(): Map<string, SiteFixBuilder> {
  if (builders) return builders;
  builders = new Map<string, SiteFixBuilder>();
  for (const registry of builderRegistries) {
    for (const [ruleId, build] of Object.entries(registry)) builders.set(ruleId, build);
  }
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

// Loads project-relative files once. Findings and fix changes name files relative to the scanned
// root.
function createFileCache(root: string): ProjectLoad {
  const resolvedRoot = path.resolve(root);
  const files = new Map<string, LoadedFile | null>();
  function load(filename: string): LoadedFile | null {
    const cached = files.get(filename);
    if (cached !== undefined) return cached;
    let entry: LoadedFile | null = null;
    try {
      if (filename.includes('\0')) throw new Error('Invalid path');
      const absolute = path.resolve(resolvedRoot, filename);
      const relative = path.relative(resolvedRoot, absolute);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Path outside project root');
      }
      // The scanner strips a byte order mark before reporting positions, so offsets here must
      // match.
      const text = fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '');
      entry = { filename, absolute, text, lineStarts: lineStartsOf(text) };
      const scriptKind = scriptKinds[path.extname(absolute).toLowerCase()];
      if (scriptKind !== undefined) {
        entry.sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, scriptKind);
        entry.scriptKind = scriptKind;
      }
    } catch {
      entry = null;
    }
    files.set(filename, entry);
    return entry;
  }
  load.projectRoot = resolvedRoot;
  // Modules that fixes built in this scan create, so two fixes never claim one new path.
  load.createdModules = new Set<string>();
  return load;
}

function reviewedDuplicateRemoval(
  finding: Finding,
  result: ModuleCreatingFix,
  hunk: FixChange,
  codeAfter: string,
): boolean {
  return Boolean(
    result.requiresReview &&
    finding.ruleId === 'duplicate-implementation' &&
    (result.createdModule || !codeAfter.includes('\n')) &&
    codeAfter.length < hunk.before.length,
  );
}

function originalLineLimit(result: ModuleCreatingFix, edits: readonly JumpRemovingEdit[]): number {
  // An extracted declaration appears in full in the created module. A guard can consume one
  // trailing jump.
  if (result.createdModule) return result.createdModule.text.split('\n').length;
  return maxHunkLines + (edits.some((edit) => edit.removesTrailingJump) ? 1 : 0);
}

// The loaded file and syntax node a builder works on, found from the finding's line and column.
function builderInputFor(finding: Finding, load: ProjectLoad): (BuilderInput & { entry: LoadedFile }) | undefined {
  if (typeof finding.file !== 'string') return;
  const entry = load(finding.file);
  const { line, column } = finding;
  if (
    !entry?.sourceFile ||
    line === undefined ||
    column === undefined ||
    !(line >= 1 && line <= entry.lineStarts.length)
  )
    return;
  const offset = entry.lineStarts[line - 1] + column - 1;
  const node = nodeAtPosition(entry, offset);
  if (!node) return;
  return { finding, node, offset, sourceFile: entry.sourceFile, text: entry.text, load, entry };
}

// What the builder's result needs to become reviewable hunks.
interface ChangeCollection {
  readonly finding: Finding;
  readonly file: string;
  readonly load: ProjectLoad;
  readonly result: ModuleCreatingFix;
  readonly comments: boolean;
  readonly entry: LoadedFile;
  readonly offset: number;
}

// The hunks of every file the fix touches, or undefined when any edit is invalid or too long to
// show.
function collectChanges({
  finding,
  file,
  load,
  result,
  comments,
  entry,
  offset,
}: ChangeCollection): { changes: FixChange[]; commentRow: number | undefined } | undefined {
  let commentRow: number | undefined;
  const changes: FixChange[] = [];
  for (const target of result.targets ?? [{ file, edits: result.edits }]) {
    const targetEntry = target.file === file ? entry : load(target.file);
    if (!targetEntry || !validFix(targetEntry, target.edits)) return;
    const maxBeforeLines = originalLineLimit(result, target.edits ?? []);
    const { edits, comment, row } =
      comments && targetEntry === entry
        ? withWhyComment({ ruleId: finding.ruleId, entry, edits: target.edits, findingOffset: offset })
        : { edits: target.edits };
    if (comment) commentRow = row;
    if (!edits) return;
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
  return { changes, commentRow };
}

// `comments: false` leaves out the why-comment above the fixed statement.
function buildFix(
  finding: Finding,
  load: ProjectLoad,
  { comments = true }: SiteFixOptions = {},
): FindingFix | undefined {
  const build = buildersByRule().get(finding.ruleId);
  if (!build || typeof finding.file !== 'string') return;
  const input = builderInputFor(finding, load);
  if (!input) return;
  const result: ModuleCreatingFix | undefined = build(input);
  if (!result) return;
  const collected = collectChanges({
    finding,
    file: finding.file,
    load,
    result,
    comments,
    entry: input.entry,
    offset: input.offset,
  });
  if (!collected) return;
  const { changes, commentRow } = collected;
  if (!changes.length || changes.every((change) => change.before === change.after)) return;
  if (result.createdModule) {
    const { file, text } = result.createdModule;
    changes.push({ file, line: 1, before: '', after: text, create: true });
  }
  const fix: FindingFix = {
    changes,
    ...(result.note && { note: result.note }),
    ...(result.requiresReview && { requiresReview: true }),
  };
  if (commentRow !== undefined) rememberCommentRow(fix, finding.file, commentRow);
  if (result.createdModule) load.createdModules?.add(result.createdModule.file);
  return fix;
}

function relatedCount(finding: Finding): number {
  return Array.isArray(finding.related) ? finding.related.length : 0;
}

// `identifierIndex` is what the scan already learned about each file's identifiers, so fixes need
// not read them again.
function attachSiteFixes(findings: Finding[], root: string, options?: SiteFixOptions): void {
  const load = createFileCache(root);
  load.identifierIndex = options?.identifierIndex;
  // The largest duplicate groups claim new module names first; a smaller group with the same helper
  // name gets a numbered one.
  const ordered = findings.toSorted((left, right) => relatedCount(right) - relatedCount(left));
  for (const finding of ordered) {
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
