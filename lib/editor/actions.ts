// Code actions and code lenses for the published findings of one file.
import { CodeActionKind } from 'vscode-languageserver';
import type { CodeAction, CodeLens, Command, Range } from 'vscode-languageserver';
import { bulkFixesFor, fixAllEdit, fixEdit } from './fix-edits.js';
import type { FixWorkspace } from './fix-edits.js';
import type { PublishedFinding, WorkspaceFix } from './diagnostics.js';
import type { DismissalEntry } from './types/dismissal.js';

const commands = {
  scan: 'loadwise.scan',
  applyFix: 'loadwise.applyFix',
  applyAllFixes: 'loadwise.applyAllFixes',
  dismiss: 'loadwise.dismiss',
  showDismissed: 'loadwise.showDismissed',
  restoreDismissed: 'loadwise.restoreDismissed',
} as const;

const fixAllKind = CodeActionKind.SourceFixAll + '.loadwise';
const applyAllTitle = 'Apply all Loadwise fixes in this file';

// `only` asks for a kind and everything below it: source.fixAll covers source.fixAll.loadwise.
function kindRequested(only: readonly string[] | undefined, kind: string): boolean {
  if (!only) return kind !== fixAllKind;
  return only.some((requested) => kind === requested || kind.startsWith(requested + '.'));
}

// The lightbulb appears with the cursor anywhere on a flagged line, not only on the reported token.
function onLines(entry: PublishedFinding, range: Range): boolean {
  const flagged = entry.diagnostic.range;
  return flagged.start.line <= range.end.line && flagged.end.line >= range.start.line;
}

function command(title: string, name: string, argument: WorkspaceFix | DismissalEntry | string): Command {
  return { title, command: name, arguments: [argument] };
}

function applyFixAction(entry: PublishedFinding, fix: WorkspaceFix, workspace: FixWorkspace): CodeAction {
  const title = 'Apply fix: ' + entry.anchor.ruleId;
  const action: CodeAction = {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [entry.diagnostic],
    isPreferred: !fix.requiresReview,
  };
  const result = fixEdit(fix, workspace);
  if (result.edit) action.edit = result.edit;
  else action.disabled = { reason: result.error };
  return action;
}

function dismissAction(entry: PublishedFinding, title: string, dismissal: DismissalEntry): CodeAction {
  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [entry.diagnostic],
    command: command(title, commands.dismiss, dismissal),
  };
}

function quickFixes(
  entries: readonly PublishedFinding[],
  range: Range,
  uri: string,
  workspace: FixWorkspace,
): CodeAction[] {
  const actions: CodeAction[] = [];
  const fileWide = new Set<string>();
  for (const entry of entries.filter((candidate) => onLines(candidate, range))) {
    const { fix, dismissal, ruleId } = entry.anchor;
    if (fix) actions.push(applyFixAction(entry, fix, workspace));
    actions.push(dismissAction(entry, 'Dismiss this finding (' + ruleId + ')', dismissal));
    if (fileWide.has(ruleId)) continue;
    fileWide.add(ruleId);
    actions.push(
      dismissAction(entry, 'Dismiss ' + ruleId + ' in this file', { file: dismissal.file, ruleId: dismissal.ruleId }),
    );
  }
  if (actions.length && bulkFixesFor(entries).eligible.length > 1) {
    actions.push({
      title: applyAllTitle,
      kind: CodeActionKind.QuickFix,
      command: command(applyAllTitle, commands.applyAllFixes, uri),
    });
  }
  return actions;
}

// Runs for "Fix All" and code actions on save, so it carries the edit itself instead of a command.
function fixAllActions(entries: readonly PublishedFinding[], workspace: FixWorkspace): CodeAction[] {
  const { eligible } = bulkFixesFor(entries);
  if (!eligible.length) return [];
  const { edit, applied } = fixAllEdit(eligible, workspace);
  if (!applied) return [];
  return [{ title: applyAllTitle, kind: fixAllKind, edit }];
}

function codeActions(
  entries: readonly PublishedFinding[],
  range: Range,
  only: readonly string[] | undefined,
  uri: string,
  workspace: FixWorkspace,
): CodeAction[] {
  const actions: CodeAction[] = [];
  if (kindRequested(only, CodeActionKind.QuickFix)) actions.push(...quickFixes(entries, range, uri, workspace));
  // Building the fix-all edit reads files, so it runs only when the editor asks for that kind.
  if (only && kindRequested(only, fixAllKind)) actions.push(...fixAllActions(entries, workspace));
  return actions;
}

// One-click buttons above each fixable line, so applying a fix does not need the code action menu.
function codeLenses(entries: readonly PublishedFinding[], uri: string): CodeLens[] {
  const fixable = entries.filter((entry) => entry.anchor.fix);
  const lenses: CodeLens[] = [];
  const bulkCount = bulkFixesFor(fixable).eligible.length;
  const top = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  if (bulkCount > 1) {
    const title = 'Apply all ' + bulkCount + ' Loadwise fixes in this file';
    lenses.push({ range: top, command: command(title, commands.applyAllFixes, uri) });
  }
  for (const { anchor, diagnostic } of fixable) {
    if (!anchor.fix) continue;
    const line = diagnostic.range.start.line;
    const range = { start: { line, character: 0 }, end: { line, character: 0 } };
    lenses.push(
      { range, command: command('Apply fix: ' + anchor.ruleId, commands.applyFix, anchor.fix) },
      { range, command: command('Dismiss', commands.dismiss, anchor.dismissal) },
    );
  }
  return lenses;
}

export { codeActions, codeLenses, commands, fixAllKind };
