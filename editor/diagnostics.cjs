'use strict';

const path = require('node:path');
const { exampleFor: performanceExample } = require('./performance-examples.cjs');
const { exampleFor: maintainabilityExample } = require('./maintainability-examples.cjs');
const { getFindingComparison, inlineComparison } = require('./finding-comparison.cjs');
const { locateChange } = require('./apply-fix.cjs');
const anchors = new WeakMap();
const polyglotLanguages = new Set(['python', 'go', 'java', 'csharp', 'rust', 'php', 'ruby', 'kotlin', 'c', 'cpp']);

const contracts = new Set([
  'data-access-boundary',
  'pg-transaction-on-pool',
  'folder-boundary',
  'file-placement',
  'query-mutates-state',
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
  const [first] = fix.changes;
  const more = fix.changes.length > 1 ? ' Also changes ' + (fix.changes.length - 1) + ' more place(s).' : '';
  return {
    kind: 'source',
    before: dedent(first.before),
    after: dedent(first.after),
    note: ((fix.note ?? '') + more + ' Press Ctrl+. (Cmd+. on macOS) to apply it.').trim(),
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

function publish(vscode, collection, rootPath, source, findings) {
  const documents = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
  const groups = new Map();
  for (const finding of findings) {
    const site = location(vscode, rootPath, finding, documents);
    if (!site || typeof finding.message !== 'string' || typeof finding.ruleId !== 'string') continue;
    const message = [finding.message, advice.get(finding.ruleId), finding.contextualReason].filter(Boolean).join('\n');
    const severity = contracts.has(finding.ruleId)
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(site.range, message, severity);
    const anchor = {
      line: finding.line,
      column: finding.column,
      message,
      suggestion: finding.suggestion,
      comparison: finding.comparison,
      fix: workspaceFix(rootPath, finding.fix),
    };
    anchors.set(diagnostic, anchor);
    diagnostic.source = source;
    diagnostic.code = finding.ruleId;
    const document = documents.get(site.uri.toString());
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

// One click applies the scanner's rewrite. The edit goes through the editor, so undo restores the original code.
async function fixEdit(vscode, fix) {
  const edit = new vscode.WorkspaceEdit();
  for (const change of fix.changes) {
    const uri = vscode.Uri.file(change.filename);
    const document = await vscode.workspace.openTextDocument(uri);
    const lines = document.getText().split(/\r?\n/);
    const row = locateChange(lines, change);
    // The code moved or changed since the scan; applying the stored rewrite could clobber the new code.
    if (row === -1) return;
    const lastRow = row + change.before.split('\n').length - 1;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const range = new vscode.Range(row, 0, lastRow, lines[lastRow].length);
    edit.replace(uri, range, change.after.split('\n').join(eol));
  }
  return edit;
}

function registerQuickFixes(vscode) {
  const applyCommand = 'backendCheckers.applyFix';
  const command = vscode.commands.registerCommand(applyCommand, async (fix) => {
    const edit = await fixEdit(vscode, fix);
    if (!edit) {
      vscode.window.showWarningMessage(
        'The code changed since the last scan. Save the file to rescan, then try again.',
      );
      return;
    }
    await vscode.workspace.applyEdit(edit);
  });
  const provider = vscode.languages.registerCodeActionsProvider(
    { scheme: 'file' },
    {
      provideCodeActions(document, range, context) {
        const actions = [];
        for (const diagnostic of context.diagnostics) {
          const fix = anchors.get(diagnostic)?.fix;
          if (!fix) continue;
          const action = new vscode.CodeAction('Apply fix: ' + diagnostic.code, vscode.CodeActionKind.QuickFix);
          action.diagnostics = [diagnostic];
          action.isPreferred = true;
          action.command = { command: applyCommand, title: action.title, arguments: [fix] };
          actions.push(action);
        }
        return actions;
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  );
  return vscode.Disposable.from(command, provider);
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
