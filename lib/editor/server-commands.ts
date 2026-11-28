// The workspace/executeCommand handlers. Arguments come back from the editor, so each one is checked
// again before it touches a file.
import path from 'node:path';
import { commands } from './actions.js';
import { bulkFixesFor, fixAllEdit, fixEdit } from './fix-edits.js';
import { isRecord } from '../shared/is-record.js';
import type { WorkspaceEdit } from 'vscode-languageserver';
import type { FolderState, ServerContext } from './language-server.js';
import type { WorkspaceChange, WorkspaceFix } from './diagnostics.js';
import type { DismissalEntry } from './types/dismissal.js';

interface FolderDismissal {
  folder: FolderState;
  entry: DismissalEntry;
}

// A message request shows one button per entry, so long lists offer Restore all and the first few.
const maxRestoreButtons = 10;

function changeArgument(context: ServerContext, value: unknown): WorkspaceChange | undefined {
  if (!isRecord(value)) return;
  const { file, filename, line, before, after, create } = value;
  if (typeof file !== 'string' || typeof filename !== 'string' || !path.isAbsolute(filename)) return;
  if (typeof before !== 'string' || typeof after !== 'string') return;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return;
  if (!context.folderFor(filename)) return;
  return { file, filename, line, before, after, ...(create === true ? { create: true } : {}) };
}

function fixArgument(context: ServerContext, value: unknown): WorkspaceFix | undefined {
  if (!isRecord(value) || !Array.isArray(value.changes) || !value.changes.length) return;
  const changes: WorkspaceChange[] = [];
  for (const item of value.changes) {
    const change = changeArgument(context, item);
    if (!change) return;
    changes.push(change);
  }
  return {
    changes,
    note: typeof value.note === 'string' ? value.note : undefined,
    requiresReview: value.requiresReview === true,
  };
}

function dismissalArgument(context: ServerContext, value: unknown): FolderDismissal | undefined {
  if (!isRecord(value) || typeof value.file !== 'string' || typeof value.ruleId !== 'string') return;
  if (!path.isAbsolute(value.file)) return;
  const folder = context.folderFor(value.file);
  if (!folder) return;
  const entry: DismissalEntry = { file: value.file, ruleId: value.ruleId };
  if (typeof value.lineText === 'string') entry.lineText = value.lineText;
  return { folder, entry };
}

async function applyEdit(context: ServerContext, edit: WorkspaceEdit, failure: string): Promise<boolean> {
  const { applied } = await context.connection.workspace.applyEdit({ label: 'Loadwise', edit });
  if (!applied) context.connection.window.showWarningMessage(failure);
  return applied;
}

async function applyFix(context: ServerContext, value: unknown): Promise<void> {
  const fix = fixArgument(context, value);
  if (!fix) return context.connection.window.showWarningMessage('Loadwise could not read this fix.');
  const result = fixEdit(fix, context.fixWorkspace());
  if (result.edit === undefined) return context.connection.window.showWarningMessage(result.error);
  await applyEdit(context, result.edit, 'Loadwise could not apply the fix.');
}

async function applyAllFixes(context: ServerContext, value: unknown): Promise<void> {
  const { window } = context.connection;
  const { eligible, reviewCount } = bulkFixesFor(typeof value === 'string' ? context.entriesFor(value) : []);
  if (!eligible.length && !reviewCount) return window.showInformationMessage('Loadwise has no fixes for this file.');
  const { edit, applied, skipped } = fixAllEdit(eligible, context.fixWorkspace());
  if (applied && !(await applyEdit(context, edit, 'Loadwise could not apply the selected fixes.'))) return;
  const summary = 'Loadwise applied ' + applied + ' fix(es)';
  const reviewNote = reviewCount ? ' ' + reviewCount + ' fix(es) require individual review.' : '';
  if (!skipped) window.showInformationMessage(summary + '.' + reviewNote);
  else
    window.showWarningMessage(
      summary + '; skipped ' + skipped + ' stale, overlapping or existing-file fix(es).' + reviewNote,
    );
}

async function dismiss(context: ServerContext, value: unknown): Promise<void> {
  const target = dismissalArgument(context, value);
  if (!target) return;
  await target.folder.dismissals.add(target.entry);
  context.republish(target.folder);
}

function allDismissed(context: ServerContext): FolderDismissal[] {
  return [...context.folders()].flatMap((folder) => folder.dismissals.entries().map((entry) => ({ folder, entry })));
}

async function restore(context: ServerContext, restored: readonly FolderDismissal[]): Promise<void> {
  const byFolder = new Map<FolderState, DismissalEntry[]>();
  for (const { folder, entry } of restored) byFolder.set(folder, [...(byFolder.get(folder) ?? []), entry]);
  for (const [folder, entries] of byFolder) {
    await folder.dismissals.remove(entries);
    context.republish(folder);
  }
}

function describe({ folder, entry }: FolderDismissal, index: number): string {
  const file = path.relative(folder.root, entry.file).split(path.sep).join('/');
  const line = typeof entry.lineText === 'string' ? entry.lineText || '(blank line)' : 'Whole file';
  return index + 1 + '. ' + entry.ruleId + ' — ' + file + ' — ' + line;
}

async function showDismissed(context: ServerContext): Promise<void> {
  const { window } = context.connection;
  const dismissed = allDismissed(context);
  if (!dismissed.length) return window.showInformationMessage('No Loadwise findings are dismissed.');
  const restoreAll = { title: 'Restore all (' + dismissed.length + ')' };
  const restoreOne = dismissed.slice(0, maxRestoreButtons).map((_item, index) => ({ title: 'Restore ' + (index + 1) }));
  const message = ['Dismissed Loadwise findings:', ...dismissed.map(describe)].join('\n');
  const picked = await window.showInformationMessage(message, restoreAll, ...restoreOne);
  if (!picked) return;
  if (picked === restoreAll || picked.title === restoreAll.title) return restore(context, dismissed);
  const index = restoreOne.findIndex((action) => action.title === picked.title);
  if (index !== -1) await restore(context, [dismissed[index]]);
}

// With a dismissal entry it restores that one; without arguments it restores every dismissal.
async function restoreDismissed(context: ServerContext, value: unknown): Promise<void> {
  if (value === undefined) return restore(context, allDismissed(context));
  const target = dismissalArgument(context, value);
  if (target) await restore(context, [target]);
}

async function scanAll(context: ServerContext): Promise<void> {
  for (const folder of context.folders()) await folder.session.scanNow();
}

function runCommand(context: ServerContext, command: string, commandArguments: readonly unknown[]): Promise<void> {
  const [argument] = commandArguments;
  switch (command) {
    case commands.scan:
      return scanAll(context);
    case commands.applyFix:
      return applyFix(context, argument);
    case commands.applyAllFixes:
      return applyAllFixes(context, argument);
    case commands.dismiss:
      return dismiss(context, argument);
    case commands.showDismissed:
      return showDismissed(context);
    case commands.restoreDismissed:
      return restoreDismissed(context, argument);
  }
  return Promise.reject(new Error('Unknown Loadwise command: ' + command));
}

export { runCommand };
