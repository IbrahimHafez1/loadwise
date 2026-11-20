'use strict';

const path = require('node:path');
const { exampleFor: performanceExample } = require('./performance-examples.cjs');
const { exampleFor: maintainabilityExample } = require('./maintainability-examples.cjs');
const { getFindingComparison, inlineComparison } = require('./finding-comparison.cjs');
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

function examplesFor(document, diagnostic, site) {
  const lookup = diagnostic.source === 'backend-perf-check' ? performanceExample : maintainabilityExample;
  const example = lookup(diagnostic.code, document.languageId, site.message);
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

module.exports = { publish, registerExamples, refreshDocument };
