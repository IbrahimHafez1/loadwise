import fs from 'node:fs';
import path from 'node:path';
import { exampleFor as performanceExample } from './performance-examples.cjs';
import { exampleFor as maintainabilityExample } from './maintainability-examples.cjs';
import { exampleFor as securityExample } from './security-examples.cjs';
import { getFindingComparison, inlineComparison } from './finding-comparison.cjs';
import { isChangeApplied, locateChange } from './apply-fix.cjs';
import type { Finding, FindingFix, FixChange } from '../lib/shared/types.js';
import type { Comparison, CodeComparison } from './types/comparison.cjs';
import type { DismissalEntry, Dismissals } from './types/dismissal.cjs';
import type { FixExample } from './types/fix-example.cjs';
import type { PublishOptions } from './types/publish-options.cjs';
import type {
  EditorApi,
  EditorCodeAction,
  EditorCodeActionKind,
  EditorCodeLens,
  EditorDiagnostic,
  EditorDiagnosticCollection,
  EditorDisposable,
  EditorDocument,
  EditorLocation,
  EditorMarkdownString,
  EditorPosition,
  EditorRange,
  EditorUri,
  EditorWorkspaceEdit,
} from './types/vscode-api.cjs';

/** A change with the absolute file it applies to. */
interface WorkspaceChange extends FixChange {
  filename: string;
}

/** A site fix whose files are all inside the workspace folder. */
interface WorkspaceFix {
  changes: WorkspaceChange[];
  note: string | undefined;
  requiresReview: boolean;
}

/** Where a finding is, once it is known to point at a real line and column. */
interface LocatedSite {
  file: string;
  line: number;
  column: number;
}

/** What the editor remembers of a published finding. */
interface DiagnosticAnchor {
  line: number;
  column: number;
  message: string;
  suggestion: unknown;
  comparison: unknown;
  fix: WorkspaceFix | undefined;
  dismissal: DismissalEntry;
}

interface CreateOperation {
  uri: EditorUri;
  key: string;
  text: string;
  create: true;
}

interface ReplaceOperation {
  uri: EditorUri;
  key: string;
  text: string;
  create?: undefined;
  firstRow: number;
  lastRow: number;
  range: EditorRange;
}

type FixOperation = CreateOperation | ReplaceOperation;

type FixPlan = { operations: FixOperation[]; error?: undefined } | { error: string; operations?: undefined };

type FixEditResult = { edit: EditorWorkspaceEdit; error?: undefined } | { error: string; edit?: undefined };

/** The rows a fix already claimed in one file. */
interface ClaimedFile {
  created: boolean;
  rows: [number, number][];
}

type DocumentOpener = (uri: EditorUri) => PromiseLike<EditorDocument>;
type DiagnosticsLookup = (uri: EditorUri) => Iterable<EditorDiagnostic>;

interface QuickFixOptions {
  diagnosticsFor: DiagnosticsLookup;
  dismissals: Dismissals;
  onDismissed(): void;
}

const anchors = new WeakMap<EditorDiagnostic, DiagnosticAnchor>();
const severityNames: Record<string, string> = {
  error: 'Error',
  warning: 'Warning',
  information: 'Information',
  hint: 'Hint',
};
const staleFixMessage = 'The code changed since the last scan. Save the file to rescan, then try again.';
const polyglotLanguages = new Set(['python', 'go', 'java', 'csharp', 'rust', 'php', 'ruby', 'kotlin', 'c', 'cpp']);

const contracts = new Set([
  'pg-transaction-on-pool',
  'folder-boundary',
  'file-placement',
  'query-mutates-state',
  'data-access-boundary',
]);

const advice = new Map([
  [
    'dependency-cycle',
    'Follow the imports in the reported cycle. Move a shared dependency into a module that both sides can import, or pass it to the caller explicitly.',
  ],
  [
    'folder-boundary',
    'Use an API the importing layer is allowed to call, or move the code that needs this dependency into the layer that owns it.',
  ],
  ['file-placement', 'Move the file to one of the configured folders and update its imports.'],
]);

function sourceExample(ruleId: string, languageId: string, message: string): FixExample | undefined {
  return performanceExample(ruleId, languageId, message) ?? securityExample(ruleId, languageId);
}

function sourceRange(
  vscode: EditorApi,
  site: Pick<LocatedSite, 'line' | 'column'>,
  document: EditorDocument | undefined,
): EditorRange {
  const line = site.line - 1;
  let column = site.column - 1;
  // ast-grep counts Unicode code points; editor positions and TypeScript use UTF-16.
  if (document && polyglotLanguages.has(document.languageId) && line < document.lineCount && column > 0) {
    let remaining = column;
    column = 0;
    for (const character of document.lineAt(line).text) {
      if (remaining === 0) break;
      column += character.length;
      remaining--;
    }
  }
  const anchor = new vscode.Range(line, column, line, column + 1);
  if (!document) return anchor;
  const range = document.validateRange(anchor);
  const word = document.getWordRangeAtPosition(range.start);
  return word?.start.isEqual(range.start) ? word : range;
}

const sentenceEnds = '.!?';

// Findings are written as short paragraphs; one sentence per line is easier to read in a tooltip.
// Code spans are kept whole, and a break needs a capital, backtick or parenthesis after the space,
// so "e.g. x" stays together.
function sentenceLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let inCode = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '`') inCode = !inCode;
    else if (
      !inCode &&
      sentenceEnds.includes(character) &&
      text[index + 1] === ' ' &&
      /[A-Z`(]/.test(text[index + 2] ?? '')
    ) {
      lines.push(text.slice(start, index + 1));
      start = index + 2;
    }
  }
  lines.push(text.slice(start));
  return lines.map((line) => line.trim()).filter(Boolean);
}

function readable(text: string): string {
  return text.split('\n').flatMap(sentenceLines).join('\n');
}

// Markdown joins single line breaks, so each sentence becomes its own paragraph.
function appendParagraphs(content: EditorMarkdownString, text: string): void {
  content.appendText(readable(text).split('\n').join('\n\n'));
}

function dedent(text: string): string {
  const lines = text.split('\n');
  const width = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0));
  return lines.map((line) => line.slice(width)).join('\n');
}

// The scanner's rewrite of this exact code; the generic rule example is only a fallback.
function fixComparison(fix: Pick<FindingFix, 'changes' | 'note' | 'requiresReview'>): CodeComparison {
  const shown = fix.changes.find((change) => !change.create) ?? fix.changes[0];
  const others = fix.changes.filter((change) => change !== shown);
  const created = others.filter((change) => change.create).map((change) => change.file);
  const edited = others.length - created.length;
  const more =
    (edited ? ' Also changes ' + edited + ' more place(s).' : '') +
    (created.length ? ' Also creates ' + created.join(', ') + '.' : '');
  return {
    kind: 'source',
    before: shown.create ? '(new file ' + shown.file + ')' : dedent(shown.before),
    after: shown.create ? shown.after.trimEnd() : dedent(shown.after),
    note: (
      (fix.note ?? '') +
      more +
      (fix.requiresReview ? ' Review this change and apply it individually.' : '') +
      ' Click Apply fix above the line, or press Ctrl+Alt+. (the same keys on every OS).'
    ).trim(),
  };
}

function examplesFor(
  document: EditorDocument,
  diagnostic: EditorDiagnostic,
  site: DiagnosticAnchor,
): { example: FixExample | undefined; comparison: Comparison | undefined } {
  // The perf watcher also reports security findings, so its lookup falls back to the security
  // examples.
  const lookup = diagnostic.source === 'loadwise perf' ? sourceExample : maintainabilityExample;
  const example = lookup(diagnostic.code ?? '', document.languageId, site.message);
  if (site.fix) return { example, comparison: fixComparison(site.fix) };
  const { source, code, range } = diagnostic;
  const comparison = getFindingComparison(document, { source, code, range, ...site }, example);
  return { example, comparison };
}

function updatePreview(document: EditorDocument, diagnostic: EditorDiagnostic, site: DiagnosticAnchor): void {
  const { comparison } = examplesFor(document, diagnostic, site);
  const preview = comparison && inlineComparison(comparison);
  diagnostic.message = preview
    ? (comparison.kind === 'source' ? 'Code: ' : '') + preview + '\n' + site.message
    : site.message;
}

function refreshDocument(vscode: EditorApi, collection: EditorDiagnosticCollection, document: EditorDocument): void {
  const diagnostics = collection.get(document.uri);
  if (!diagnostics?.length) return;
  for (const diagnostic of diagnostics) {
    const site = anchors.get(diagnostic);
    if (site) {
      diagnostic.range = sourceRange(vscode, site, document);
      updatePreview(document, diagnostic, site);
    }
  }
  collection.set(document.uri, diagnostics);
}

function isLocatedSite(site: unknown): site is LocatedSite {
  if (typeof site !== 'object' || site === null) return false;
  if (!('file' in site) || !('line' in site) || !('column' in site)) return false;
  return (
    typeof site.file === 'string' &&
    site.file !== '' &&
    !site.file.includes('\0') &&
    typeof site.line === 'number' &&
    Number.isSafeInteger(site.line) &&
    site.line >= 1 &&
    typeof site.column === 'number' &&
    Number.isSafeInteger(site.column) &&
    site.column >= 1
  );
}

function location(
  vscode: EditorApi,
  rootPath: string,
  site: unknown,
  documents: ReadonlyMap<string, EditorDocument>,
): EditorLocation | undefined {
  if (!isLocatedSite(site)) return;
  const filename = path.resolve(rootPath, site.file);
  const relative = path.relative(rootPath, filename);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
  const uri = vscode.Uri.file(filename);
  const document = documents.get(uri.toString());
  return new vscode.Location(uri, sourceRange(vscode, site, document));
}

// Resolves each change of a site fix inside the workspace folder; a path outside it drops the whole
// fix.
function workspaceFix(rootPath: string, fix: FindingFix | undefined): WorkspaceFix | undefined {
  if (!fix || !Array.isArray(fix.changes) || !fix.changes.length) return;
  const changes: WorkspaceChange[] = [];
  for (const change of fix.changes) {
    if (
      typeof change?.file !== 'string' ||
      change.file.includes('\0') ||
      typeof change.before !== 'string' ||
      typeof change.after !== 'string'
    )
      return;
    if (!Number.isSafeInteger(change.line) || change.line < 1) return;
    const filename = path.resolve(rootPath, change.file);
    const relative = path.relative(rootPath, filename);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
    changes.push({ ...change, filename });
  }
  return {
    changes,
    note: typeof fix.note === 'string' ? fix.note : undefined,
    requiresReview: fix.requiresReview === true,
  };
}

// Every finding is an optional suggestion: a warning by default, an error for a declared contract,
// unless the loadwise.severity setting picks one level for all of them.
function severityFor(vscode: EditorApi, finding: Finding, setting: string | undefined): number {
  const isError = finding.level === 'error' || (finding.level !== 'warn' && contracts.has(finding.ruleId));
  const name = (setting === undefined ? undefined : severityNames[setting]) ?? (isError ? 'Error' : 'Warning');
  return vscode.DiagnosticSeverity[name];
}

// The trimmed text of the reported line identifies a dismissed finding, so it is read from the
// scanned file.
function flaggedLineText(
  filename: string,
  line: number,
  document: EditorDocument | undefined,
  fileLines: Map<string, string[]>,
): string {
  if (document && !document.isDirty) return line <= document.lineCount ? document.lineAt(line - 1).text.trim() : '';
  if (!fileLines.has(filename)) {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
    } catch {
      // A file deleted since the scan has no line text; its findings disappear on the next scan.
    }
    fileLines.set(filename, lines);
  }
  return ((fileLines.get(filename) ?? [])[line - 1] ?? '').trim();
}

// A live-database finding names a table, not a file. It is shown on the first line of the project's
// package.json, prefixed by the table, and dismissed by table name.
function databaseFinding(finding: Finding): Finding {
  if (finding.file !== undefined || typeof finding.target !== 'string' || typeof finding.message !== 'string')
    return finding;
  return { ...finding, file: 'package.json', line: 1, column: 1, message: finding.target + ': ' + finding.message };
}

function publish(
  vscode: EditorApi,
  collection: EditorDiagnosticCollection,
  rootPath: string,
  source: string,
  findings: Finding[],
  { isDismissed, severity: severitySetting }: PublishOptions = {},
): void {
  const documents = new Map<string, EditorDocument>(
    vscode.workspace.textDocuments.map((document): [string, EditorDocument] => [document.uri.toString(), document]),
  );
  const fileLines = new Map<string, string[]>();
  const groups = new Map<string, [EditorUri, EditorDiagnostic[]]>();
  for (const reported of findings) {
    const finding = databaseFinding(reported);
    if (!isLocatedSite(finding)) continue;
    const site = location(vscode, rootPath, finding, documents);
    if (!site || typeof finding.message !== 'string' || typeof finding.ruleId !== 'string') continue;
    const document = documents.get(site.uri.toString());
    const filename = path.resolve(rootPath, finding.file);
    const lineText =
      finding === reported
        ? flaggedLineText(filename, finding.line, document, fileLines)
        : typeof finding.target === 'string'
          ? finding.target
          : undefined;
    const dismissal: DismissalEntry = { file: filename, ruleId: finding.ruleId, lineText };
    if (isDismissed?.(dismissal)) continue;
    const message = readable(
      [finding.message, advice.get(finding.ruleId), finding.contextualReason].filter(Boolean).join('\n'),
    );
    const diagnostic = new vscode.Diagnostic(site.range, message, severityFor(vscode, finding, severitySetting));
    const anchor: DiagnosticAnchor = {
      line: finding.line,
      column: finding.column,
      message,
      suggestion: finding.suggestion,
      comparison: finding.comparison,
      fix: workspaceFix(rootPath, finding.fix),
      dismissal,
    };
    anchors.set(diagnostic, anchor);
    diagnostic.source = source;
    diagnostic.code = finding.ruleId;
    if (document) updatePreview(document, diagnostic, anchor);
    if (Array.isArray(finding.related)) {
      const label = finding.ruleId === 'dependency-cycle' ? 'Import in this cycle' : 'Matching implementation';
      diagnostic.relatedInformation = finding.related.flatMap((item: unknown) => {
        const link = location(vscode, rootPath, item, documents);
        return link ? [new vscode.DiagnosticRelatedInformation(link, label)] : [];
      });
    }
    const key = site.uri.toString();
    let group = groups.get(key);
    if (!group) {
      group = [site.uri, []];
      groups.set(key, group);
    }
    group[1].push(diagnostic);
  }
  const updates: [EditorUri, EditorDiagnostic[] | undefined][] = [...groups.values()];
  collection.forEach((uri) => {
    if (!groups.has(uri.toString())) updates.push([uri, undefined]);
  });
  collection.set(updates);
}

// The current text of a file a fix would create, or undefined when it does not exist.
function existingText(vscode: EditorApi, uri: EditorUri): PromiseLike<string | undefined> {
  return vscode.workspace.fs.readFile(uri).then(
    (bytes) => new TextDecoder().decode(bytes).replaceAll('\r\n', '\n'),
    () => undefined,
  );
}

// Resolves every change of one fix against the current files. Any stale change or existing file to
// create rejects the whole fix, so a multi-file fix applies all-or-nothing.
async function planFix(vscode: EditorApi, fix: WorkspaceFix, openDocument: DocumentOpener): Promise<FixPlan> {
  const operations: FixOperation[] = [];
  let alreadyApplied = 0;
  for (const change of fix.changes) {
    const uri = vscode.Uri.file(change.filename);
    const key = uri.toString();
    if (change.create) {
      const existing = await existingText(vscode, uri);
      // Never overwrite: the file may hold work written since the scan. The same content means it
      // is already applied.
      if (existing === undefined) operations.push({ uri, key, create: true, text: change.after });
      else if (existing.replaceAll('\r\n', '\n') !== change.after.replaceAll('\r\n', '\n'))
        return { error: change.file + ' already exists, so the fix was not applied.' };
      else alreadyApplied++;
      continue;
    }
    let document: EditorDocument;
    try {
      document = await openDocument(uri);
    } catch {
      return { error: staleFixMessage };
    }
    const lines = document.getText().split(/\r?\n/);
    const row = locateChange(lines, change);
    // The code moved or changed since the scan; applying the stored rewrite could clobber the new
    // code.
    if (row === -1) return { error: staleFixMessage };
    if (isChangeApplied(lines, row, change)) {
      alreadyApplied++;
      continue;
    }
    const lastRow = row + change.before.split(/\r?\n/).length - 1;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const range = new vscode.Range(row, 0, lastRow, lines[lastRow].length);
    operations.push({ uri, key, firstRow: row, lastRow, range, text: change.after.split(/\r?\n/).join(eol) });
  }
  if (!operations.length && alreadyApplied) return { error: 'This fix is already applied.' };
  return { operations };
}

function addOperations(vscode: EditorApi, edit: EditorWorkspaceEdit, operations: readonly FixOperation[]): void {
  for (const operation of operations) {
    if (operation.create) {
      edit.createFile(operation.uri, { ignoreIfExists: false });
      edit.insert(operation.uri, new vscode.Position(0, 0), operation.text);
    } else edit.replace(operation.uri, operation.range, operation.text);
  }
}

function cachedOpener(vscode: EditorApi): DocumentOpener {
  const documents = new Map<string, PromiseLike<EditorDocument>>();
  return (uri) => {
    const key = uri.toString();
    let opened = documents.get(key);
    if (!opened) {
      opened = vscode.workspace.openTextDocument(uri);
      documents.set(key, opened);
    }
    return opened;
  };
}

// One click applies the scanner's rewrite. The edit goes through the editor, so undo restores the
// original code.
async function fixEdit(vscode: EditorApi, fix: WorkspaceFix): Promise<FixEditResult> {
  const plan = await planFix(vscode, fix, cachedOpener(vscode));
  if (plan.operations === undefined) return plan;
  const edit = new vscode.WorkspaceEdit();
  addOperations(vscode, edit, plan.operations);
  return { edit };
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
function bulkFixesFor(diagnostics: readonly EditorDiagnostic[]): { eligible: WorkspaceFix[]; reviewCount: number } {
  const unique = new Map<string, WorkspaceFix>();
  for (const diagnostic of diagnostics) {
    const fix = anchors.get(diagnostic)?.fix;
    if (!fix) continue;
    const key = JSON.stringify(fix.changes);
    if (!unique.has(key) || fix.requiresReview) unique.set(key, fix);
  }
  const eligible = [...unique.values()].filter((fix) => !fix.requiresReview);
  return { eligible, reviewCount: unique.size - eligible.length };
}

// Every applicable fix in one WorkspaceEdit, so one undo reverts them all. Stale fixes, fixes that
// would create an existing file, and fixes overlapping an earlier one are skipped whole.
async function fixAllEdit(
  vscode: EditorApi,
  fixes: readonly WorkspaceFix[],
): Promise<{ edit: EditorWorkspaceEdit; applied: number; skipped: number }> {
  const openDocument = cachedOpener(vscode);
  const edit = new vscode.WorkspaceEdit();
  const claimed = new Map<string, ClaimedFile>();
  let applied = 0;
  for (const fix of fixes) {
    const plan = await planFix(vscode, fix, openDocument);
    if (plan.operations === undefined || plan.operations.some((operation) => overlaps(claimed, operation))) continue;
    for (const operation of plan.operations) claim(claimed, operation);
    addOperations(vscode, edit, plan.operations);
    applied++;
  }
  return { edit, applied, skipped: fixes.length - applied };
}

// The lightbulb appears with the cursor anywhere on a flagged line, not only on the reported token.
function onLines(diagnostic: EditorDiagnostic, range: EditorRange): boolean {
  return diagnostic.range.start.line <= range.end.line && diagnostic.range.end.line >= range.start.line;
}

function registerQuickFixes(
  vscode: EditorApi,
  { diagnosticsFor, dismissals, onDismissed }: QuickFixOptions,
): EditorDisposable {
  const applyCommand = 'loadwise.applyFix';
  const applyAllCommand = 'loadwise.applyAllFixes';
  const dismissCommand = 'loadwise.dismiss';
  const applyAllTitle = 'Apply all Loadwise fixes in this file';
  const fixAllKind = vscode.CodeActionKind.SourceFixAll.append('loadwise');
  const issuesIn = (uri: EditorUri) => [...diagnosticsFor(uri)].filter((diagnostic) => anchors.has(diagnostic));
  const applyOne = vscode.commands.registerCommand(applyCommand, async (fix: WorkspaceFix) => {
    const result = await fixEdit(vscode, fix);
    if (result.edit === undefined) {
      vscode.window.showWarningMessage(result.error);
      return;
    }
    const ok = await vscode.workspace.applyEdit(result.edit);
    if (!ok) vscode.window.showWarningMessage('Loadwise could not apply the fix.');
  });
  const applyAll = vscode.commands.registerCommand(applyAllCommand, async (uri?: EditorUri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const { eligible, reviewCount } = bulkFixesFor(target ? issuesIn(target) : []);
    if (!eligible.length && !reviewCount) {
      vscode.window.showInformationMessage('Loadwise has no fixes for this file.');
      return;
    }
    const { edit, applied, skipped } = await fixAllEdit(vscode, eligible);
    if (applied) {
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        vscode.window.showWarningMessage('Loadwise could not apply the selected fixes.');
        return;
      }
    }
    const summary = 'Loadwise applied ' + applied + ' fix(es)';
    const reviewNote = reviewCount ? ' ' + reviewCount + ' fix(es) require individual review.' : '';
    if (!skipped) vscode.window.showInformationMessage(summary + '.' + reviewNote);
    else
      vscode.window.showWarningMessage(
        summary + '; skipped ' + skipped + ' stale, overlapping or existing-file fix(es).' + reviewNote,
      );
  });
  const dismiss = vscode.commands.registerCommand(dismissCommand, async (entry: DismissalEntry) => {
    await dismissals.add(entry);
    onDismissed();
  });
  // The findings on the cursor's line; one is picked by rule when the line has several.
  async function pickAtCursor(wantsFix: boolean): Promise<DiagnosticAnchor | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const line = editor.selection.active.line;
    const here = issuesIn(editor.document.uri).filter(
      (diagnostic) =>
        diagnostic.range.start.line <= line &&
        diagnostic.range.end.line >= line &&
        (!wantsFix || anchors.get(diagnostic)?.fix),
    );
    if (!here.length) {
      vscode.window.showInformationMessage(
        wantsFix ? 'Loadwise has no fix on this line.' : 'Loadwise has no finding on this line.',
      );
      return;
    }
    if (here.length === 1) return anchors.get(here[0]);
    const picked = await vscode.window.showQuickPick(
      here.map((diagnostic) => ({ label: String(diagnostic.code), anchor: anchors.get(diagnostic) })),
      { placeHolder: wantsFix ? 'Pick the fix to apply' : 'Pick the finding to dismiss' },
    );
    return picked?.anchor;
  }
  const applyHere = vscode.commands.registerCommand('loadwise.applyFixAtCursor', async () => {
    const anchor = await pickAtCursor(true);
    if (anchor) await vscode.commands.executeCommand(applyCommand, anchor.fix);
  });
  const dismissHere = vscode.commands.registerCommand('loadwise.dismissAtCursor', async () => {
    const anchor = await pickAtCursor(false);
    if (anchor) await vscode.commands.executeCommand(dismissCommand, anchor.dismissal);
  });
  function quickFixes(document: EditorDocument, range: EditorRange): EditorCodeAction[] {
    const actions: EditorCodeAction[] = [];
    const fileWide = new Set<string | undefined>();
    const issues = issuesIn(document.uri);
    for (const diagnostic of issues.filter((issue) => onLines(issue, range))) {
      const anchor = anchors.get(diagnostic);
      if (!anchor) continue;
      const { fix, dismissal } = anchor;
      const addAction = (
        title: string,
        command: string,
        argument: WorkspaceFix | DismissalEntry,
        preferred = false,
      ) => {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = preferred;
        action.command = { command, title, arguments: [argument] };
        actions.push(action);
      };
      if (fix) addAction('Apply fix: ' + diagnostic.code, applyCommand, fix, !fix.requiresReview);
      addAction('Dismiss this finding (' + diagnostic.code + ')', dismissCommand, dismissal);
      if (fileWide.has(diagnostic.code)) continue;
      fileWide.add(diagnostic.code);
      addAction('Dismiss ' + diagnostic.code + ' in this file', dismissCommand, {
        file: dismissal.file,
        ruleId: dismissal.ruleId,
      });
    }
    if (actions.length && bulkFixesFor(issues).eligible.length > 1) {
      const action = new vscode.CodeAction(applyAllTitle, vscode.CodeActionKind.QuickFix);
      action.command = { command: applyAllCommand, title: applyAllTitle, arguments: [document.uri] };
      actions.push(action);
    }
    return actions;
  }
  // Runs for "Fix All" and editor.codeActionsOnSave, so it carries the edit itself instead of a
  // command.
  async function fixAll(document: EditorDocument): Promise<EditorCodeAction[]> {
    const { eligible: fixes } = bulkFixesFor(issuesIn(document.uri));
    if (!fixes.length) return [];
    const { edit, applied } = await fixAllEdit(vscode, fixes);
    if (!applied) return [];
    const action = new vscode.CodeAction(applyAllTitle, fixAllKind);
    action.edit = edit;
    return [action];
  }
  const provider = vscode.languages.registerCodeActionsProvider(
    { scheme: 'file' },
    {
      provideCodeActions(document: EditorDocument, range: EditorRange, context: { only?: EditorCodeActionKind }) {
        // Building the fix-all edit reads files, so it runs only when the editor asks for that
        // kind.
        if (context.only && fixAllKind.intersects(context.only)) return fixAll(document);
        return quickFixes(document, range);
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, fixAllKind] },
  );
  return vscode.Disposable.from(applyOne, applyAll, dismiss, applyHere, dismissHere, provider);
}

// One-click buttons above each fixable line, so applying a fix does not need the lightbulb menu.
function registerCodeLenses(
  vscode: EditorApi,
  diagnosticsFor: DiagnosticsLookup,
): { refresh(): void; disposable: EditorDisposable } {
  const changed = new vscode.EventEmitter();
  const provider = vscode.languages.registerCodeLensProvider(
    { scheme: 'file' },
    {
      onDidChangeCodeLenses: changed.event,
      provideCodeLenses(document: EditorDocument) {
        if (!vscode.workspace.getConfiguration('loadwise', document.uri).get('codeLens', true)) return [];
        const fixable = [...diagnosticsFor(document.uri)].filter((diagnostic) => anchors.get(diagnostic)?.fix);
        const lenses: EditorCodeLens[] = [];
        const bulkCount = bulkFixesFor(fixable).eligible.length;
        if (bulkCount > 1) {
          lenses.push(
            new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
              title: '$(wrench) Apply all ' + bulkCount + ' Loadwise fixes in this file',
              command: 'loadwise.applyAllFixes',
              arguments: [document.uri],
            }),
          );
        }
        for (const diagnostic of fixable) {
          const anchor = anchors.get(diagnostic);
          if (!anchor) continue;
          const { fix, dismissal } = anchor;
          const line = diagnostic.range.start.line;
          const range = new vscode.Range(line, 0, line, 0);
          lenses.push(
            new vscode.CodeLens(range, {
              title: '$(wrench) Apply fix: ' + diagnostic.code,
              command: 'loadwise.applyFix',
              arguments: [fix],
            }),
            new vscode.CodeLens(range, {
              title: 'Dismiss',
              command: 'loadwise.dismiss',
              arguments: [dismissal],
            }),
          );
        }
        return lenses;
      },
    },
  );
  return { refresh: () => changed.fire(), disposable: vscode.Disposable.from(provider, changed) };
}

function commandLink(title: string, command: string, argument: WorkspaceFix | DismissalEntry): string {
  const encoded = encodeURIComponent(JSON.stringify([argument]))
    .replaceAll('(', '%28')
    .replaceAll(')', '%29');
  return '[' + title + '](command:' + command + '?' + encoded + ')';
}

function registerExamples(vscode: EditorApi, diagnosticsFor: DiagnosticsLookup): EditorDisposable {
  return vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    {
      provideHover(document: EditorDocument, position: EditorPosition) {
        const examples: EditorMarkdownString[] = [];
        const shown = new Set<string | undefined>();
        let hoverRange: EditorRange | undefined;
        const word = document.getWordRangeAtPosition(position);
        for (const issue of diagnosticsFor(document.uri)) {
          const site = anchors.get(issue);
          if (!site) continue;
          const range = word?.start.isEqual(issue.range.start) ? word : issue.range;
          if (!range.contains(position) || shown.has(issue.code)) continue;
          const { example, comparison } = examplesFor(document, issue, site);
          if (!comparison && !example) continue;
          const content = new vscode.MarkdownString();
          if (!issue.range.contains(position)) {
            appendParagraphs(content, site.message);
            content.appendText('\n\n');
          }
          if (comparison) {
            content.appendText(
              (comparison.kind === 'source' ? 'Current code' : 'Flagged line') + ' (' + issue.code + ')',
            );
            content.appendCodeblock(comparison.before, document.languageId);
            appendComparisonOutcome(comparison, content, example, document);
          } else if (example) {
            content.appendText('Illustrative alternative (' + issue.code + ')');
            content.appendCodeblock(example.code, example.language);
          }
          const note = comparison ? comparison.note : example?.note;
          if (note) appendParagraphs(content, note);
          if (site.fix) {
            // Only these two commands may run from the hover links.
            content.isTrusted = { enabledCommands: ['loadwise.applyFix', 'loadwise.dismiss'] };
            content.appendMarkdown(
              '\n\n' +
                commandLink('$(wrench) Apply fix', 'loadwise.applyFix', site.fix) +
                ' · ' +
                commandLink('Dismiss', 'loadwise.dismiss', site.dismissal),
            );
            content.supportThemeIcons = true;
          }
          examples.push(content);
          shown.add(issue.code);
          hoverRange ??= range;
        }
        if (examples.length) return new vscode.Hover(examples, hoverRange);
      },
    },
  );
}

function appendComparisonOutcome(
  comparison: Comparison,
  content: EditorMarkdownString,
  example: FixExample | undefined,
  document: EditorDocument,
): void {
  if (comparison.kind === 'review') content.appendText('Review: ' + comparison.inline);
  else {
    content.appendText(comparison.kind === 'source' ? 'Suggested rewrite' : 'Illustrative alternative');
    content.appendCodeblock(comparison.after, comparison.language ?? example?.language ?? document.languageId);
  }
}

export { publish, registerCodeLenses, registerExamples, registerQuickFixes, refreshDocument, workspaceFix };
