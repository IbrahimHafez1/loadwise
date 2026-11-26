import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ts from 'typescript';
import { applyFix } from '../../editor/apply-fix.cjs';
import { realTarget } from './real-target.js';
import { introducedSyntaxError, refusalReason } from './fix-safety.js';
import { errorCode, errorMessage } from './error-code.js';
import { formatUpdates } from './fix-presentation.js';
import { coalesceImportChanges, isPureImportChange } from './fix-imports.js';
import { introducedTypeErrors } from './fix-typecheck.js';
import type { Declaration, Node } from 'typescript';
import type { Finding, FixChange } from './types.js';
import type { FileUpdate, FixableFinding, UpdateHunk } from './types/fix-run.js';

export const MAX_FIX_PASSES = 4;

interface StagedUpdate extends FileUpdate {
  temporary: string;
}

export interface RefusedFinding {
  finding: Finding;
  reason: string;
}

interface StagedFixes {
  updates: FileUpdate[];
  refusals: Map<string, string>;
  hunksByFile: Map<string, UpdateHunk[]>;
}

interface Split {
  kept: FixableFinding[];
  refused: RefusedFinding[];
}

interface ChangeRange {
  file: string;
  first: number;
  last: number;
  key: string;
  change: FixChange;
}

interface ClaimedRange extends ChangeRange {
  finding: FixableFinding;
}

export interface WrittenFixes {
  applied: FixableFinding[];
  refused: RefusedFinding[];
  changedFiles: number;
  updates: FileUpdate[];
}

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80];

function hasFix(finding: Finding): finding is FixableFinding {
  return Boolean(finding.fix);
}

function currentText(filename: string): string | undefined {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

const changeKey = (file: string, change: FixChange): string =>
  JSON.stringify([file, change.line, change.before, change.after, Boolean(change.create)]);

export function hunkRange(change: FixChange): [number, number] {
  return change.create ? [1, Infinity] : [change.line, change.line + change.before.split('\n').length - 1];
}

function collectChanges(findings: readonly FixableFinding[], directory: string): FixChange[] {
  const root = fs.realpathSync.native(directory);
  const changes = new Map<string, FixChange>();
  for (const finding of findings) {
    for (const change of finding.fix.changes) {
      const file = realTarget(path.resolve(directory, change.file));
      const relative = path.relative(root, file);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error(`Fix #${finding.id} targets a file outside the current project: ${change.file}`);
      }
      changes.set(changeKey(file, change), { ...change, file });
    }
  }
  return [...changes.values()];
}

function validateSource(file: string, text: string): void {
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  ts.bindSourceFile(source, {});
  const [diagnostic] = source.bindDiagnostics ?? [];
  if (diagnostic)
    throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} No fixes applied.`);
  const hasBody = (declaration: Declaration): boolean =>
    (ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isConstructorDeclaration(declaration)) &&
    Boolean(declaration.body);
  function duplicateImplementation(node: Node): string | undefined {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) &&
      node.body &&
      (node.symbol?.declarations?.filter((declaration) => declaration.kind === node.kind && hasBody(declaration))
        .length ?? 0) > 1
    ) {
      return node.name?.getText(source) ?? 'constructor';
    }
    return ts.forEachChild(node, duplicateImplementation);
  }
  const duplicate = duplicateImplementation(source);
  if (duplicate) throw new Error(`${file}: duplicate implementation of ${duplicate}. No fixes applied.`);
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code && TRANSIENT_RENAME_ERRORS.has(code) && attempt < RENAME_RETRY_DELAYS_MS.length) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw error;
    }
  }
}

function commitStagedUpdates(staged: readonly StagedUpdate[], written: StagedUpdate[]): void {
  for (const update of staged) {
    const { file, before, temporary } = update;
    if (currentText(file) !== before || realTarget(file) !== file)
      throw new Error('File changed while applying fixes: ' + file);
    if (before === undefined) fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
    else renameWithRetry(temporary, file);
    written.push(update);
  }
}

function writeUpdates(updates: readonly FileUpdate[]): void {
  const staged: StagedUpdate[] = [];
  const written: StagedUpdate[] = [];
  try {
    for (const update of updates) {
      const { file, before } = update;
      if (currentText(file) !== before || realTarget(file) !== file)
        throw new Error('File changed while applying fixes: ' + file);
      if (before === undefined) fs.mkdirSync(path.dirname(file), { recursive: true });
      else fs.accessSync(file, fs.constants.W_OK);
      const temporary = path.join(path.dirname(file), '.loadwise-' + randomUUID() + '.tmp');
      const descriptor = fs.openSync(temporary, 'wx');
      staged.push({ ...update, temporary });
      try {
        fs.writeFileSync(descriptor, update.after);
        if (before !== undefined) fs.fchmodSync(descriptor, fs.statSync(file).mode);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    commitStagedUpdates(staged, written);
  } catch (error) {
    const unrestored: string[] = [];
    for (const { file, before, after, temporary } of written.reverse()) {
      try {
        if (realTarget(file) !== file || currentText(file) !== after) unrestored.push(file);
        else if (before === undefined) fs.unlinkSync(file);
        else {
          fs.writeFileSync(temporary, before, { flag: 'wx', mode: fs.statSync(file).mode });
          renameWithRetry(temporary, file);
        }
      } catch {
        unrestored.push(file);
      }
    }
    const detail = unrestored.length ? ' Review files that could not be restored: ' + unrestored.join(', ') : '';
    throw new Error(errorMessage(error) + detail);
  } finally {
    for (const { temporary } of staged) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch (error) {
        console.error(`Could not remove ${temporary}: ${errorMessage(error)}`);
      }
    }
  }
}

function stageFixes(
  findings: readonly FixableFinding[],
  directory: string,
  { verifyTypes = true, virtualFiles }: { verifyTypes?: boolean; virtualFiles?: Map<string, string | undefined> } = {},
): StagedFixes {
  const readText = (file: string): string | undefined =>
    virtualFiles?.has(file) ? virtualFiles.get(file) : currentText(file);
  const changes = coalesceImportChanges(collectChanges(findings, directory), readText);
  const originals = new Map<string, string | undefined>();
  const updates: FileUpdate[] = [];
  const refusals = new Map<string, string>();
  const hunksByFile = new Map<string, UpdateHunk[]>();
  function capture(change: FixChange): void {
    const hunks = hunksByFile.get(change.file) ?? [];
    hunksByFile.set(change.file, hunks);
    hunks.push({
      key: changeKey(change.file, change),
      row: change.line - 1,
      removed: change.create ? 0 : change.before.split('\n').length,
      added: change.after.split('\n').length,
    });
  }
  const result = changes.length
    ? applyFix(
        { changes },
        {
          readFile(file: string): string | undefined {
            const text = readText(file);
            originals.set(file, text);
            return text;
          },
          writeFile(file: string, after: string): void {
            const syntaxError = introducedSyntaxError(file, originals.get(file), after);
            if (syntaxError) {
              refusals.set(file, refusalReason(file, syntaxError));
              return;
            }
            validateSource(file, after);
            updates.push({ file, before: originals.get(file), after });
          },
        },
        { exactLocation: true, capture },
      )
    : undefined;
  if (result?.error)
    throw new Error(result.error + '. No fixes applied. Run loadwise check to choose individual fixes.');
  if (verifyTypes && updates.length) {
    const updatedMap = new Map<string, string>(updates.map((update) => [update.file, update.after]));
    for (const [file, reason] of introducedTypeErrors(directory, originals, updatedMap)) refusals.set(file, reason);
  }
  return {
    updates: refusals.size ? updates.filter((update) => !refusals.has(update.file)) : updates,
    refusals,
    hunksByFile,
  };
}

function splitRefused(
  findings: readonly FixableFinding[],
  directory: string,
  refusals: ReadonlyMap<string, string>,
): Split {
  const kept: FixableFinding[] = [];
  const refused: RefusedFinding[] = [];
  for (const finding of findings) {
    const files = finding.fix.changes.map((change: FixChange) => realTarget(path.resolve(directory, change.file)));
    const blocked = files.find((file: string) => refusals.has(file));
    const reason = blocked === undefined ? undefined : refusals.get(blocked);
    if (reason !== undefined) refused.push({ finding, reason });
    else kept.push(finding);
  }
  return { kept, refused };
}

function splitCreateConflicts(findings: readonly FixableFinding[], directory: string): Split {
  const owners = new Map<string, { finding: FixableFinding; key: string }>();
  for (const finding of findings) {
    for (const change of finding.fix.changes) {
      if (!change.create) continue;
      const file = realTarget(path.resolve(directory, change.file));
      if (!owners.has(file)) owners.set(file, { finding, key: changeKey(file, change) });
    }
  }
  const kept: FixableFinding[] = [];
  const refused: RefusedFinding[] = [];
  for (const finding of findings) {
    const conflict = finding.fix.changes
      .map((change) => ({ change, file: realTarget(path.resolve(directory, change.file)) }))
      .find(({ change, file }) => {
        const owner = owners.get(file);
        return owner && owner.finding !== finding && changeKey(file, change) !== owner.key;
      });
    const owner = conflict ? owners.get(conflict.file) : undefined;
    if (!conflict || !owner) kept.push(finding);
    else {
      refused.push({
        finding,
        reason: `#${owner.finding.id} creates ${conflict.change.file} in this run; run the fix again after it`,
      });
    }
  }
  return { kept, refused };
}

function splitOverlapConflicts(findings: readonly FixableFinding[], directory: string): Split {
  const claimed = new Map<string, ClaimedRange[]>();
  const kept: FixableFinding[] = [];
  const refused: RefusedFinding[] = [];
  for (const finding of findings) {
    const ranges = finding.fix.changes
      .filter((change: FixChange) => !change.create)
      .map((change: FixChange): ChangeRange => {
        const file = realTarget(path.resolve(directory, change.file));
        const [first, last] = hunkRange(change);
        return { file, first, last, key: changeKey(file, change), change };
      });
    const overlap = (range: ChangeRange): ClaimedRange | undefined =>
      claimed
        .get(range.file)
        ?.find(
          (owner) =>
            owner.key !== range.key &&
            !(isPureImportChange(owner.change) && isPureImportChange(range.change)) &&
            owner.first <= range.last &&
            range.first <= owner.last,
        );
    const conflict = ranges.map((range) => ({ range, owner: overlap(range) })).find((entry) => entry.owner);
    if (conflict?.owner) {
      refused.push({
        finding,
        reason: `#${conflict.owner.finding.id} changes ${conflict.range.change.file}:${conflict.range.first} in this run; run the fix again after it`,
      });
      continue;
    }
    kept.push(finding);
    for (const range of ranges) {
      const owned = claimed.get(range.file) ?? [];
      claimed.set(range.file, owned);
      owned.push({ ...range, finding });
    }
  }
  return { kept, refused };
}

function showFormattedChanges(
  findings: readonly FixableFinding[],
  directory: string,
  updates: FileUpdate[],
  hunksByFile: ReadonlyMap<string, UpdateHunk[]>,
): void {
  const formatted = formatUpdates(
    directory,
    updates.map((update: FileUpdate) => ({ ...update, hunks: hunksByFile.get(update.file) ?? [] })),
  );
  const unformatted = new Set<string>();
  for (const update of updates) {
    const text = formatted.texts.get(update.file);
    if (text === undefined) continue;
    if (introducedSyntaxError(update.file, update.before, text)) unformatted.add(update.file);
    else update.after = text;
  }
  for (const finding of findings) {
    for (const change of finding.fix.changes) {
      const file = realTarget(path.resolve(directory, change.file));
      if (unformatted.has(file)) continue;
      const hunk = formatted.hunks.get(changeKey(file, change));
      if (hunk) Object.assign(change, hunk);
    }
  }
}

function relocateChange(change: FixChange, fileText: string): FixChange | undefined {
  if (change.create || !change.before) return change;
  const firstIndex = fileText.indexOf(change.before);
  if (firstIndex === -1 || fileText.indexOf(change.before, firstIndex + 1) !== -1) return undefined;
  const newLine = fileText.slice(0, firstIndex).split('\n').length;
  return newLine === change.line ? change : { ...change, line: newLine };
}

function relocateFindingChanges(
  finding: FixableFinding,
  directory: string,
  virtualFiles: ReadonlyMap<string, string | undefined>,
): FixableFinding | undefined {
  const relocatedChanges: FixChange[] = [];
  for (const change of finding.fix.changes) {
    const file = realTarget(path.resolve(directory, change.file));
    const text = virtualFiles.get(file);
    if (change.create) {
      if (text !== undefined) return undefined;
      relocatedChanges.push(change);
      continue;
    }
    if (text === undefined) {
      relocatedChanges.push(change);
      continue;
    }
    const moved = relocateChange(change, text);
    if (!moved) return undefined;
    relocatedChanges.push(moved);
  }
  return { ...finding, fix: { ...finding.fix, changes: relocatedChanges } };
}

function relocateDeferred(
  deferred: readonly RefusedFinding[],
  directory: string,
  virtualFiles: ReadonlyMap<string, string | undefined>,
): { retryable: FixableFinding[]; unresolvable: RefusedFinding[] } {
  const retryable: FixableFinding[] = [];
  const unresolvable: RefusedFinding[] = [];
  for (const item of deferred) {
    const relocated = hasFix(item.finding) ? relocateFindingChanges(item.finding, directory, virtualFiles) : undefined;
    if (relocated) retryable.push(relocated);
    else unresolvable.push(item);
  }
  return { retryable, unresolvable };
}

interface SinglePassInput {
  pending: readonly FixableFinding[];
  directory: string;
  format: boolean;
  verifyTypes: boolean;
  virtualFiles: Map<string, string | undefined>;
  diskOriginals: Map<string, string | undefined>;
}

function recordStagedUpdates(
  updates: readonly FileUpdate[],
  diskOriginals: Map<string, string | undefined>,
  virtualFiles: Map<string, string | undefined>,
): void {
  for (const update of updates) {
    if (!diskOriginals.has(update.file)) diskOriginals.set(update.file, currentText(update.file));
    virtualFiles.set(update.file, update.after);
  }
}

function runSinglePass({ pending, directory, format, verifyTypes, virtualFiles, diskOriginals }: SinglePassInput): {
  applied: FixableFinding[];
  refused: RefusedFinding[];
  deferred: RefusedFinding[];
} {
  const conflicts = splitCreateConflicts(pending, directory);
  const overlaps = splitOverlapConflicts(conflicts.kept, directory);
  let remaining = overlaps.kept;
  const refused: RefusedFinding[] = [];

  for (;;) {
    const { updates, refusals, hunksByFile } = stageFixes(remaining, directory, { verifyTypes, virtualFiles });
    if (!refusals.size) {
      if (format) showFormattedChanges(remaining, directory, updates, hunksByFile);
      recordStagedUpdates(updates, diskOriginals, virtualFiles);
      return { applied: remaining, refused, deferred: [...conflicts.refused, ...overlaps.refused] };
    }
    const split = splitRefused(remaining, directory, refusals);
    refused.push(...split.refused);
    remaining = split.kept;
  }
}

export function writeFixes(
  findings: readonly FixableFinding[],
  directory: string,
  { format, verifyTypes = true, dryRun = false }: { format: boolean; verifyTypes?: boolean; dryRun?: boolean },
): WrittenFixes {
  const virtualFiles = new Map<string, string | undefined>();
  const diskOriginals = new Map<string, string | undefined>();
  const allApplied: FixableFinding[] = [];
  const allRefused: RefusedFinding[] = [];
  let pending: FixableFinding[] = [...findings];

  for (let pass = 1; pass <= MAX_FIX_PASSES && pending.length; pass++) {
    const passResult = runSinglePass({ pending, directory, format, verifyTypes, virtualFiles, diskOriginals });
    allApplied.push(...passResult.applied);
    allRefused.push(...passResult.refused);
    if (!passResult.deferred.length || pass === MAX_FIX_PASSES) {
      allRefused.push(...passResult.deferred);
      break;
    }
    const { retryable, unresolvable } = relocateDeferred(passResult.deferred, directory, virtualFiles);
    allRefused.push(...unresolvable);
    if (!retryable.length) break;
    pending = retryable;
  }

  const finalUpdates: FileUpdate[] = [];
  for (const [file, before] of diskOriginals) {
    const after = virtualFiles.get(file);
    if (after !== undefined && after !== before) finalUpdates.push({ file, before, after });
  }
  if (!dryRun && finalUpdates.length) writeUpdates(finalUpdates);
  return { applied: allApplied, refused: allRefused, changedFiles: finalUpdates.length, updates: finalUpdates };
}
