'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exampleFor: performanceExample } = require('./performance-examples.cjs');
const { exampleFor: maintainabilityExample } = require('./maintainability-examples.cjs');
const { getFindingComparison, inlineComparison } = require('./finding-comparison.cjs');
const { locateChange } = require('./apply-fix.cjs');
const anchors = new WeakMap();
const severityNames = { error: 'Error', warning: 'Warning', information: 'Information', hint: 'Hint' };
const staleFixMessage = 'The code changed since the last scan. Save the file to rescan, then try again.';
const polyglotLanguages = new Set(['python', 'go', 'java', 'csharp', 'rust', 'php', 'ruby', 'kotlin', 'c', 'cpp']);

const contracts = new Set(['pg-transaction-on-pool', 'folder-boundary', 'file-placement', 'query-mutates-state']);

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

function sourceRange(vscode, site, document) {
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

function dedent(text) {
  const lines = text.split('\n');
  const width = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)[0].length));
  return lines.map((line) => line.slice(width)).join('\n');
}

// The scanner's rewrite of this exact code; the generic rule example is only a fallback.
function fixComparison(fix) {
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
    note: ((fix.note ?? '') + more + ' Press Ctrl+. (Cmd+. on macOS) to apply or dismiss it.').trim(),
  };
}

function examplesFor(document, diagnostic, site) {
  const lookup = diagnostic.source === 'backend-perf-check' ? performanceExample : maintainabilityExample;
  const example = lookup(diagnostic.code, document.languageId, site.message);
  if (site.fix) return { example, comparison: fixComparison(site.fix) };
  const { source, code, range } = diagnostic;
  const comparison = getFindingComparison(document, { source, code, range, ...site }, example);
  return { example, comparison };
}

function updatePreview(document, diagnostic, site) {
  const { comparison } = examplesFor(document, diagnostic, site);
  const preview = comparison && inlineComparison(comparison);
  diagnostic.message = preview
    ? (comparison.kind === 'source' ? 'Code: ' : '') + preview + '\n' + site.message
    : site.message;
}

function refreshDocument(vscode, collection, document) {
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

function location(vscode, rootPath, site, documents) {
  if (!site || typeof site.file !== 'string' || !site.file || site.file.includes('\0')) return;
  if (!Number.isSafeInteger(site.line) || site.line < 1 || !Number.isSafeInteger(site.column) || site.column < 1)
    return;
  const filename = path.resolve(rootPath, site.file);
  const relative = path.relative(rootPath, filename);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
  const uri = vscode.Uri.file(filename);
  const document = documents.get(uri.toString());
  return new vscode.Location(uri, sourceRange(vscode, site, document));
}

// Resolves each change of a site fix inside the workspace folder; a path outside it drops the whole fix.
function workspaceFix(rootPath, fix) {
  if (!fix || !Array.isArray(fix.changes) || !fix.changes.length) return;
  const changes = [];
  for (const change of fix.changes) {
    if (typeof change?.file !== 'string' || typeof change.before !== 'string' || typeof change.after !== 'string')
      return;
    if (!Number.isSafeInteger(change.line) || change.line < 1) return;
    const filename = path.resolve(rootPath, change.file);
    const relative = path.relative(rootPath, filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    changes.push({ ...change, filename });
  }
  return { changes, note: typeof fix.note === 'string' ? fix.note : undefined };
}

// Every finding is an optional suggestion: a warning by default, an error for a declared contract, unless the
// backendCheckers.severity setting picks one level for all of them.
function severityFor(vscode, ruleId, setting) {
  const name = severityNames[setting] ?? (contracts.has(ruleId) ? 'Error' : 'Warning');
  return vscode.DiagnosticSeverity[name];
}

// The trimmed text of the reported line identifies a dismissed finding, so it is read from the scanned file.
function flaggedLineText(filename, line, document, fileLines) {
  if (document && !document.isDirty) return line <= document.lineCount ? document.lineAt(line - 1).text.trim() : '';
  if (!fileLines.has(filename)) {
    let lines = [];
    try {
      lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
    } catch {
      // A file deleted since the scan has no line text; its findings disappear on the next scan.
    }
    fileLines.set(filename, lines);
  }
  return (fileLines.get(filename)[line - 1] ?? '').trim();
}

// A live-database finding names a table, not a file. It is shown on the first line of the project's package.json,
// prefixed by the table, and dismissed by table name.
function databaseFinding(finding) {
  if (finding.file !== undefined || typeof finding.target !== 'string' || typeof finding.message !== 'string')
    return finding;
  return { ...finding, file: 'package.json', line: 1, column: 1, message: finding.target + ': ' + finding.message };
}

function publish(vscode, collection, rootPath, source, findings, { isDismissed, severity: severitySetting } = {}) {
  const documents = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
  const fileLines = new Map();
  const groups = new Map();
  for (const reported of findings) {
    const finding = databaseFinding(reported);
    const site = location(vscode, rootPath, finding, documents);
    if (!site || typeof finding.message !== 'string' || typeof finding.ruleId !== 'string') continue;
    const document = documents.get(site.uri.toString());
    const filename = path.resolve(rootPath, finding.file);
    const lineText =
      finding === reported ? flaggedLineText(filename, finding.line, document, fileLines) : finding.target;
    const dismissal = { file: filename, ruleId: finding.ruleId, lineText };
    if (isDismissed?.(dismissal)) continue;
    const message = [finding.message, advice.get(finding.ruleId), finding.contextualReason].filter(Boolean).join('\n');
    const diagnostic = new vscode.Diagnostic(site.range, message, severityFor(vscode, finding.ruleId, severitySetting));
    const anchor = {
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
      diagnostic.relatedInformation = finding.related.flatMap((item) => {
        const link = location(vscode, rootPath, item, documents);
        return link ? [new vscode.DiagnosticRelatedInformation(link, label)] : [];
      });
    }
    const key = site.uri.toString();
    if (!groups.has(key)) groups.set(key, [site.uri, []]);
    groups.get(key)[1].push(diagnostic);
  }
  const updates = [...groups.values()];
  collection.forEach((uri) => {
    if (!groups.has(uri.toString())) updates.push([uri, undefined]);
  });
  collection.set(updates);
}

// The current text of a file a fix would create, or undefined when it does not exist.
function existingText(vscode, uri) {
  return vscode.workspace.fs.readFile(uri).then(
    (bytes) => new TextDecoder().decode(bytes).replace(/\r\n/g, '\n'),
    () => undefined,
  );
}

// Resolves every change of one fix against the current files. Any stale change or existing file to create rejects
// the whole fix, so a multi-file fix applies all-or-nothing.
async function planFix(vscode, fix, openDocument) {
  const operations = [];
  let alreadyApplied = 0;
  for (const change of fix.changes) {
    const uri = vscode.Uri.file(change.filename);
    const key = uri.toString();
    if (change.create) {
      const existing = await existingText(vscode, uri);
      // Never overwrite: the file may hold work written since the scan. The same content means it is already applied.
      if (existing === undefined) operations.push({ uri, key, create: true, text: change.after });
      else if (existing !== change.after)
        return { error: change.file + ' already exists, so the fix was not applied.' };
      else alreadyApplied++;
      continue;
    }
    const document = await openDocument(uri);
    const lines = document.getText().split(/\r?\n/);
    const row = locateChange(lines, change);
    // The code moved or changed since the scan; applying the stored rewrite could clobber the new code.
    if (row === -1) return { error: staleFixMessage };
    const lastRow = row + change.before.split('\n').length - 1;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const range = new vscode.Range(row, 0, lastRow, lines[lastRow].length);
    operations.push({ uri, key, firstRow: row, lastRow, range, text: change.after.split('\n').join(eol) });
  }
  if (!operations.length && alreadyApplied) return { error: 'This fix is already applied.' };
  return { operations };
}

function addOperations(vscode, edit, operations) {
  for (const operation of operations) {
    if (operation.create) {
      edit.createFile(operation.uri, { ignoreIfExists: false });
      edit.insert(operation.uri, new vscode.Position(0, 0), operation.text);
    } else edit.replace(operation.uri, operation.range, operation.text);
  }
}

function cachedOpener(vscode) {
  const documents = new Map();
  return (uri) => {
    const key = uri.toString();
    if (!documents.has(key)) documents.set(key, vscode.workspace.openTextDocument(uri));
    return documents.get(key);
  };
}

// One click applies the scanner's rewrite. The edit goes through the editor, so undo restores the original code.
async function fixEdit(vscode, fix) {
  const plan = await planFix(vscode, fix, cachedOpener(vscode));
  if (plan.error) return plan;
  const edit = new vscode.WorkspaceEdit();
  addOperations(vscode, edit, plan.operations);
  return { edit };
}

function overlaps(claimed, operation) {
  const taken = claimed.get(operation.key);
  if (!taken) return false;
  if (operation.create || taken.created) return true;
  return taken.rows.some(([first, last]) => operation.firstRow <= last && first <= operation.lastRow);
}

function claim(claimed, operation) {
  if (!claimed.has(operation.key)) claimed.set(operation.key, { created: false, rows: [] });
  const taken = claimed.get(operation.key);
  if (operation.create) taken.created = true;
  else taken.rows.push([operation.firstRow, operation.lastRow]);
}

// Every applicable fix in one WorkspaceEdit, so one undo reverts them all. Stale fixes, fixes that would create an
// existing file, and fixes overlapping an earlier one are skipped whole.
async function fixAllEdit(vscode, fixes) {
  const openDocument = cachedOpener(vscode);
  const unique = new Map(fixes.map((fix) => [JSON.stringify(fix.changes), fix]));
  const edit = new vscode.WorkspaceEdit();
  const claimed = new Map();
  let applied = 0;
  for (const fix of unique.values()) {
    const plan = await planFix(vscode, fix, openDocument);
    if (plan.error || plan.operations.some((operation) => overlaps(claimed, operation))) continue;
    for (const operation of plan.operations) claim(claimed, operation);
    addOperations(vscode, edit, plan.operations);
    applied++;
  }
  return { edit, applied, skipped: unique.size - applied };
}

// The lightbulb appears with the cursor anywhere on a flagged line, not only on the reported token.
function onLines(diagnostic, range) {
  return diagnostic.range.start.line <= range.end.line && diagnostic.range.end.line >= range.start.line;
}

function registerQuickFixes(vscode, { diagnosticsFor, dismissals, onDismissed }) {
  const applyCommand = 'backendCheckers.applyFix';
  const applyAllCommand = 'backendCheckers.applyAllFixes';
  const dismissCommand = 'backendCheckers.dismiss';
  const applyAllTitle = 'Apply all Backend Checkers fixes in this file';
  const fixAllKind = vscode.CodeActionKind.SourceFixAll.append('backendCheckers');
  const issuesIn = (uri) => [...diagnosticsFor(uri)].filter((diagnostic) => anchors.has(diagnostic));
  const fixesIn = (uri) => issuesIn(uri).flatMap((diagnostic) => anchors.get(diagnostic).fix ?? []);
  const applyOne = vscode.commands.registerCommand(applyCommand, async (fix) => {
    const result = await fixEdit(vscode, fix);
    if (result.error) {
      vscode.window.showWarningMessage(result.error);
      return;
    }
    await vscode.workspace.applyEdit(result.edit);
  });
  const applyAll = vscode.commands.registerCommand(applyAllCommand, async (uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const fixes = target ? fixesIn(target) : [];
    if (!fixes.length) {
      vscode.window.showInformationMessage('Backend Checkers has no fixes for this file.');
      return;
    }
    const { edit, applied, skipped } = await fixAllEdit(vscode, fixes);
    if (applied) await vscode.workspace.applyEdit(edit);
    const summary = 'Backend Checkers applied ' + applied + ' fix(es)';
    if (!skipped) vscode.window.showInformationMessage(summary + '.');
    else
      vscode.window.showWarningMessage(
        summary + '; skipped ' + skipped + ' stale, overlapping or existing-file fix(es).',
      );
  });
  const dismiss = vscode.commands.registerCommand(dismissCommand, async (entry) => {
    await dismissals.add(entry);
    onDismissed();
  });
  function quickFixes(document, range) {
    const actions = [];
    const fileWide = new Set();
    const issues = issuesIn(document.uri);
    for (const diagnostic of issues.filter((issue) => onLines(issue, range))) {
      const { fix, dismissal } = anchors.get(diagnostic);
      const addAction = (title, command, argument, preferred = false) => {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = preferred;
        action.command = { command, title, arguments: [argument] };
        actions.push(action);
      };
      if (fix) addAction('Apply fix: ' + diagnostic.code, applyCommand, fix, true);
      addAction('Dismiss this finding (' + diagnostic.code + ')', dismissCommand, dismissal);
      if (fileWide.has(diagnostic.code)) continue;
      fileWide.add(diagnostic.code);
      addAction('Dismiss ' + diagnostic.code + ' in this file', dismissCommand, {
        file: dismissal.file,
        ruleId: dismissal.ruleId,
      });
    }
    if (actions.length && issues.filter((issue) => anchors.get(issue).fix).length > 1) {
      const action = new vscode.CodeAction(applyAllTitle, vscode.CodeActionKind.QuickFix);
      action.command = { command: applyAllCommand, title: applyAllTitle, arguments: [document.uri] };
      actions.push(action);
    }
    return actions;
  }
  // Runs for "Fix All" and editor.codeActionsOnSave, so it carries the edit itself instead of a command.
  async function fixAll(document) {
    const fixes = fixesIn(document.uri);
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
      provideCodeActions(document, range, context) {
        // Building the fix-all edit reads files, so it runs only when the editor asks for that kind.
        if (context.only && fixAllKind.intersects(context.only)) return fixAll(document);
        return quickFixes(document, range);
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, fixAllKind] },
  );
  return vscode.Disposable.from(applyOne, applyAll, dismiss, provider);
}

function registerExamples(vscode, diagnosticsFor) {
  return vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    {
      provideHover(document, position) {
        const examples = [];
        const shown = new Set();
        let hoverRange;
        const word = document.getWordRangeAtPosition(position);
        for (const issue of diagnosticsFor(document.uri)) {
          const site = anchors.get(issue);
          if (!site) continue;
          const range = word?.start.isEqual(issue.range.start) ? word : issue.range;
          if (!range.contains(position) || shown.has(issue.code)) continue;
          const { example, comparison } = examplesFor(document, issue, site);
          if (!comparison && !example) continue;
          const content = new vscode.MarkdownString();
          if (!issue.range.contains(position)) content.appendText(site.message + '\n\n');
          if (comparison) {
            content.appendText(
              (comparison.kind === 'source' ? 'Current code' : 'Flagged line') + ' (' + issue.code + ')',
            );
            content.appendCodeblock(comparison.before, document.languageId);
            if (comparison.kind === 'review') content.appendText('Review: ' + comparison.inline);
            else {
              content.appendText(comparison.kind === 'source' ? 'Suggested rewrite' : 'Illustrative alternative');
              content.appendCodeblock(
                comparison.after,
                comparison.language ?? example?.language ?? document.languageId,
              );
            }
          } else {
            content.appendText('Illustrative alternative (' + issue.code + ')');
            content.appendCodeblock(example.code, example.language);
          }
          const note = comparison ? comparison.note : example?.note;
          if (note) content.appendText(note);
          examples.push(content);
          shown.add(issue.code);
          hoverRange ??= range;
        }
        if (examples.length) return new vscode.Hover(examples, hoverRange);
      },
    },
  );
}

module.exports = { publish, registerExamples, registerQuickFixes, refreshDocument, workspaceFix };
