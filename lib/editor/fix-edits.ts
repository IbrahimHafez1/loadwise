// Builds the workspace edits that apply scanner fixes. A fix stores the exact original lines, so it
// applies only where they still exist in the editor's buffer (or the saved file when it is not
// open); code changed since the scan refuses the fix instead of guessing. The edit goes through the
// editor, so undo restores the original code.
import { isChangeApplied, locateChange } from './apply-fix.js';
import type { CreateFile, Range, TextDocumentEdit, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import type { EditorDocument } from './editor-document.js';
import type { PublishedFinding, WorkspaceFix } from './diagnostics.js';

/** How the server reads files and names them for the editor. */
export interface FixWorkspace {
  /** The open buffer or the saved file; undefined when the file does not exist. */
  documentFor(filename: string): EditorDocument | undefined;
  uriFor(filename: string): string;
  /** A key that is equal for two spellings of one file. */
  keyOf(filename: string): string;
  /** Whether the editor accepts document changes with created files. */
  canCreateFiles: boolean;
  /** Whether the editor accepts `documentChanges`; otherwise the edit uses `changes`. */
  supportsDocumentChanges: boolean;
}

interface CreateOperation {
  filename: string;
  key: string;
  text: string;
  create: true;
}

interface ReplaceOperation {
  filename: string;
  key: string;
  version: number | null;
  text: string;
  create?: undefined;
  firstRow: number;
  lastRow: number;
  range: Range;
}

type FixOperation = CreateOperation | ReplaceOperation;

type FixPlan = { operations: FixOperation[]; error?: undefined } | { error: string; operations?: undefined };

export type FixEditResult = { edit: WorkspaceEdit; error?: undefined } | { error: string; edit?: undefined };

/** The rows a fix already claimed in one file. */
interface ClaimedFile {
  created: boolean;
  rows: [number, number][];
}

const staleFixMessage = 'The code changed since the last scan. Save the file to rescan, then try again.';
const noCreateMessage = 'This editor cannot create files through the language server, so the fix was not applied.';

function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function planCreate(change: WorkspaceFix['changes'][number], workspace: FixWorkspace): FixPlan | 'applied' {
  const existing = workspace.documentFor(change.filename);
  // Never overwrite: the file may hold work written since the scan. The same content means it is
  // already applied.
  if (existing === undefined) {
    if (!workspace.canCreateFiles) return { error: noCreateMessage };
    return {
      operations: [
        { filename: change.filename, key: workspace.keyOf(change.filename), create: true, text: change.after },
      ],
    };
  }
  if (normalizeNewlines(existing.getText()) !== normalizeNewlines(change.after))
    return { error: change.file + ' already exists, so the fix was not applied.' };
  return 'applied';
}

function planReplace(change: WorkspaceFix['changes'][number], workspace: FixWorkspace): FixPlan | 'applied' {
  const document = workspace.documentFor(change.filename);
  if (!document) return { error: staleFixMessage };
  const lines = document.getText().split(/\r?\n/);
  const row = locateChange(lines, change);
  // The code moved or changed since the scan; applying the stored rewrite could clobber the new
  // code.
  if (row === -1) return { error: staleFixMessage };
  if (isChangeApplied(lines, row, change)) return 'applied';
  const lastRow = row + change.before.split(/\r?\n/).length - 1;
  const range = { start: { line: row, character: 0 }, end: { line: lastRow, character: lines[lastRow].length } };
  const operation: ReplaceOperation = {
    filename: change.filename,
    key: workspace.keyOf(change.filename),
    version: document.version,
    firstRow: row,
    lastRow,
    range,
    text: change.after.split(/\r?\n/).join(document.eol),
  };
  return { operations: [operation] };
}

// Resolves every change of one fix against the current files. Any stale change or existing file to
// create rejects the whole fix, so a multi-file fix applies all-or-nothing.
function planFix(fix: WorkspaceFix, workspace: FixWorkspace): FixPlan {
  const operations: FixOperation[] = [];
  let alreadyApplied = 0;
  for (const change of fix.changes) {
    const plan = change.create ? planCreate(change, workspace) : planReplace(change, workspace);
    if (plan === 'applied') alreadyApplied++;
    else if (plan.operations === undefined) return plan;
    else operations.push(...plan.operations);
  }
  if (!operations.length && alreadyApplied) return { error: 'This fix is already applied.' };
  return { operations };
}

function documentChanges(
  operations: readonly FixOperation[],
  workspace: FixWorkspace,
): (TextDocumentEdit | CreateFile)[] {
  const changes: (TextDocumentEdit | CreateFile)[] = [];
  const editsByFile = new Map<string, TextEdit[]>();
  for (const operation of operations) {
    const uri = workspace.uriFor(operation.filename);
    if (operation.create) {
      changes.push({ kind: 'create', uri, options: { overwrite: false, ignoreIfExists: false } });
      const start = { line: 0, character: 0 };
      changes.push({
        textDocument: { uri, version: null },
        edits: [{ range: { start, end: start }, newText: operation.text }],
      });
      continue;
    }
    const edit = { range: operation.range, newText: operation.text };
    const edits = editsByFile.get(operation.key);
    if (edits) {
      edits.push(edit);
      continue;
    }
    const fileEdits = [edit];
    editsByFile.set(operation.key, fileEdits);
    changes.push({ textDocument: { uri, version: operation.version }, edits: fileEdits });
  }
  return changes;
}

function plainChanges(operations: readonly FixOperation[], workspace: FixWorkspace): Record<string, TextEdit[]> {
  const changes: Record<string, TextEdit[]> = {};
  for (const operation of operations) {
    if (operation.create) continue;
    const uri = workspace.uriFor(operation.filename);
    (changes[uri] ??= []).push({ range: operation.range, newText: operation.text });
  }
  return changes;
}

function workspaceEdit(operations: readonly FixOperation[], workspace: FixWorkspace): WorkspaceEdit {
  if (workspace.supportsDocumentChanges) return { documentChanges: documentChanges(operations, workspace) };
  return { changes: plainChanges(operations, workspace) };
}

/** The edit applying one fix, or why it cannot apply. */
function fixEdit(fix: WorkspaceFix, workspace: FixWorkspace): FixEditResult {
  const plan = planFix(fix, workspace);
  if (plan.operations === undefined) return plan;
  return { edit: workspaceEdit(plan.operations, workspace) };
}

function overlaps(claimed: ReadonlyMap<string, ClaimedFile>, operation: FixOperation): boolean {
  const taken = claimed.get(operation.key);
  if (!taken) return false;
  if (operation.create || taken.created) return true;
  return taken.rows.some(([first, last]) => operation.firstRow <= last && first <= operation.lastRow);
}

function claim(claimed: Map<string, ClaimedFile>, operation: FixOperation): void {
  let taken = claimed.get(operation.key);
  if (!taken) {
    taken = { created: false, rows: [] };
    claimed.set(operation.key, taken);
  }
  if (operation.create) taken.created = true;
  else taken.rows.push([operation.firstRow, operation.lastRow]);
}

// Identical rewrites can come from several findings. Any request for review applies to the shared
// rewrite.
function bulkFixesFor(entries: readonly PublishedFinding[]): { eligible: WorkspaceFix[]; reviewCount: number } {
  const unique = new Map<string, WorkspaceFix>();
  for (const { anchor } of entries) {
    const fix = anchor.fix;
    if (!fix) continue;
    const key = JSON.stringify(fix.changes);
    if (!unique.has(key) || fix.requiresReview) unique.set(key, fix);
  }
  const eligible = [...unique.values()].filter((fix) => !fix.requiresReview);
  return { eligible, reviewCount: unique.size - eligible.length };
}

// Every applicable fix in one edit, so one undo reverts them all. Stale fixes, fixes that would
// create an existing file, and fixes overlapping an earlier one are skipped whole.
function fixAllEdit(
  fixes: readonly WorkspaceFix[],
  workspace: FixWorkspace,
): { edit: WorkspaceEdit; applied: number; skipped: number } {
  const claimed = new Map<string, ClaimedFile>();
  const operations: FixOperation[] = [];
  let applied = 0;
  for (const fix of fixes) {
    const plan = planFix(fix, workspace);
    if (plan.operations === undefined || plan.operations.some((operation) => overlaps(claimed, operation))) continue;
    for (const operation of plan.operations) claim(claimed, operation);
    operations.push(...plan.operations);
    applied++;
  }
  return { edit: workspaceEdit(operations, workspace), applied, skipped: fixes.length - applied };
}

export { bulkFixesFor, fixAllEdit, fixEdit };
