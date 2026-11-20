'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { publish, refreshDocument, registerExamples, registerQuickFixes } = require('../diagnostics.cjs');

function fixture() {
  const root = path.resolve('example');
  const uri = path.join(root, 'app.py');
  const byUri = new Map();
  const vscode = {
    Uri: { file: (file) => file },
    Range: class {
      constructor(line, character, endLine, endCharacter) {
        this.start = { line, character };
        this.end = { line: endLine, character: endCharacter };
      }
      contains(position) {
        return (
          this.start.line === position.line &&
          position.character >= this.start.character &&
          position.character <= this.end.character
        );
      }
    },
    Location: class {
      constructor(uri, range) {
        this.uri = uri;
        this.range = range;
      }
    },
    Diagnostic: class {
      constructor(range, message, severity) {
        Object.assign(this, { range, message, severity });
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    workspace: { textDocuments: [] },
  };
  const collection = {
    forEach: (visit) => {
      for (const uri of byUri.keys()) visit(uri);
    },
    get: (uri) => byUri.get(uri),
    set(entries, diagnostics) {
      for (const [uri, current] of diagnostics ? [[entries, diagnostics]] : entries) {
        if (current) byUri.set(uri, current);
        else byUri.delete(uri);
      }
    },
  };
  return { root, uri, vscode, collection, byUri };
}

test('snapshots replace stale markers and discard traversal paths and invalid source locations', () => {
  const { vscode, collection, root, uri, byUri } = fixture();
  const finding = { file: 'app.py', line: 3, column: 2, ruleId: 'file-placement', message: 'Declared policy.' };
  publish(vscode, collection, root, 'maintainability-check', [
    finding,
    { ...finding, file: '../private.py' },
    { ...finding, column: 0 },
  ]);
  assert.equal(byUri.size, 1);
  const [issue] = collection.get(uri);
  assert.equal(collection.get(uri).length, 1);
  assert.equal(issue.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(issue.code, finding.ruleId);
  assert.match(issue.message, /Move the file/);
  assert.deepEqual(issue.range.start, { line: 2, character: 1 });
  publish(vscode, collection, root, 'maintainability-check', []);
  assert.equal(byUri.size, 0);
});

function getHover(vscode, document, diagnostic) {
  vscode.MarkdownString = class {
    parts = [];
    appendText(text) {
      this.parts.push({ text });
    }
    appendCodeblock(code, language) {
      this.parts.push({ code, language });
    }
  };
  vscode.Hover = class {
    constructor(contents) {
      this.contents = contents;
    }
  };
  vscode.languages = {
    registerHoverProvider: (_selector, provider) => provider,
  };
  return registerExamples(vscode, () => [diagnostic]).provideHover(document, diagnostic.range.start).contents[0].parts;
}

test('opening a saved file shows the actual before and suggested after in its hover', () => {
  const { vscode, collection, root } = fixture();
  const text = 'return required.every((key) => held.includes(key));';
  const document = {
    uri: path.join(root, 'permissions.ts'),
    languageId: 'typescript',
    lineCount: 1,
    lineAt: () => ({ text }),
    validateRange: (range) => range,
    getWordRangeAtPosition: () => undefined,
  };
  const finding = {
    file: 'permissions.ts',
    line: 1,
    column: text.indexOf('includes') + 1,
    ruleId: 'array-repeated-membership',
    message: 'Membership checks repeatedly scan the same array.',
  };
  publish(vscode, collection, root, 'backend-perf-check', [finding]);
  refreshDocument(vscode, collection, document);
  const [diagnostic] = collection.get(document.uri);
  assert.ok(diagnostic.message.endsWith(finding.message));
  const parts = getHover(vscode, document, diagnostic);
  assert.match(parts[0].text, /Current code/);
  assert.deepEqual(parts[1], { code: text, language: 'typescript' });
  assert.equal(parts[2].text, 'Suggested rewrite');
  assert.match(parts[3].code, /heldSet\.has\(key\)/);
  assert.match(parts[4].text, /stable/);
  const originalPreview = diagnostic.message;
  refreshDocument(vscode, collection, document);
  assert.equal(diagnostic.message, originalPreview);
  document.isDirty = true;
  assert.match(getHover(vscode, document, diagnostic)[0].text, /Illustrative alternative/);
});

test('a short nested-control-flow rewrite appears before the explanation on the diagnostic itself', () => {
  const { vscode, collection, root } = fixture();
  const uri = path.join(root, 'pipeline.ts');
  const text = '    if (!startTime) startTime = new Date();';
  const document = {
    uri,
    lineCount: 1,
    languageId: 'typescript',
    lineAt: () => ({ text }),
    validateRange: (range) => range,
    getWordRangeAtPosition: () => undefined,
  };
  vscode.workspace.textDocuments.push(document);
  const message = 'Control flow reaches 4 nested levels.';
  publish(vscode, collection, root, 'maintainability-check', [
    { file: 'pipeline.ts', line: 1, column: 5, ruleId: 'deep-control-flow', message },
  ]);
  const [diagnostic] = collection.get(uri);
  assert.deepEqual(diagnostic.message.split('\n'), ['Code: ' + text.trim() + ' → startTime ||= new Date();', message]);
  const parts = getHover(vscode, document, diagnostic);
  assert.equal(parts[1].code, text.trim());
  assert.equal(parts[3].code, 'startTime ||= new Date();');
  assert.match(parts[4].text, /falsy/);
  refreshDocument(vscode, collection, document);
  assert.equal(diagnostic.message.split('\n').length, 2);
});

test('an advisory without a verified rewrite labels the reported line and illustrative example separately', () => {
  const { vscode, collection, root, uri } = fixture();
  const text = '    if should_retry(job):';
  const document = {
    uri,
    languageId: 'python',
    lineCount: 1,
    lineAt: () => ({ text }),
    validateRange: (range) => range,
    getWordRangeAtPosition: () => undefined,
  };
  vscode.workspace.textDocuments.push(document);
  publish(vscode, collection, root, 'maintainability-check', [
    {
      file: 'app.py',
      line: 1,
      column: 5,
      ruleId: 'deep-control-flow',
      message: 'Control flow reaches 4 nested levels.',
    },
  ]);
  const [diagnostic] = collection.get(uri);
  const parts = getHover(vscode, document, diagnostic);
  assert.match(parts[0].text, /Flagged line/);
  assert.equal(parts[1].code.trim(), text.trim());
  assert.equal(parts[2].text, 'Illustrative alternative');
  assert.equal(parts[3].language, 'python');
  assert.match(parts[3].code, /continue/);
  assert.ok(parts[4].text);
});

test('opening a polyglot file converts columns after astral characters to editor UTF-16 positions', () => {
  const { vscode, collection, root, uri } = fixture();
  const line = 'label = "😀"; process()';
  const character = line.indexOf('process');
  const column = Array.from(line.slice(0, character)).length + 1;
  publish(vscode, collection, root, 'backend-perf-check', [
    { file: 'app.py', ruleId: 'an-example-rule', message: 'Example message.', line: 1, column },
  ]);
  refreshDocument(vscode, collection, {
    uri,
    languageId: 'python',
    lineCount: 1,
    lineAt: () => ({ text: line }),
    validateRange: (range) => range,
    getWordRangeAtPosition: () => undefined,
  });
  assert.equal(collection.get(uri)[0].range.start.character, character);
});

test('scanner review advice survives reopening and provides a single flagged snippet without an unrelated rewrite', () => {
  const { vscode, collection, root } = fixture();
  const text = 'function load(scope) {';
  const document = {
    uri: path.join(root, 'service.ts'),
    languageId: 'typescript',
    lineCount: 1,
    lineAt: () => ({ text }),
    validateRange: (range) => range,
    getWordRangeAtPosition: () => undefined,
  };
  const suggestion = 'Extract the shared input checks after comparing both callers.';
  publish(vscode, collection, root, 'maintainability-check', [
    {
      file: 'service.ts',
      line: 1,
      column: 1,
      ruleId: 'duplicate-implementation',
      message: 'Duplicate code.',
      suggestion,
    },
  ]);
  refreshDocument(vscode, collection, document);
  const [diagnostic] = collection.get(document.uri);
  assert.equal(diagnostic.message.split('\n')[0], 'Review: ' + suggestion);
  const parts = getHover(vscode, document, diagnostic);
  assert.deepEqual(
    parts.filter((part) => part.code !== undefined),
    [{ code: text, language: 'typescript' }],
  );
  assert.equal(parts.at(-1).text, 'Review: ' + suggestion);
});

test('hover retains the scanner-proven edit when the diagnostic is reopened from its collection', () => {
  const { vscode, collection, root } = fixture();
  const lines = ['if (ready) {', '  if (allowed) notify();', '} else {', '  skip();', '}', 'continue;'];
  const comparison = {
    line: 1,
    before: lines.join('\n'),
    code: 'if (!ready) {\n  skip();\n  continue;\n}\nif (allowed) notify();\ncontinue;',
    inline: 'if (ready) { … } else { … } → if (!ready) { …; continue; }',
    note: 'Checked at the enclosing loop.',
    language: 'typescript',
  };
  const document = {
    uri: path.join(root, 'loop.ts'),
    languageId: 'typescript',
    lineCount: lines.length,
    lineAt: (index) => ({ text: lines[index] }),
    validateRange: (range) => range,
    getWordRangeAtPosition: () => undefined,
  };
  publish(vscode, collection, root, 'maintainability-check', [
    {
      file: 'loop.ts',
      line: 2,
      column: 3,
      ruleId: 'deep-control-flow',
      message: 'Nested branch.',
      comparison,
    },
  ]);
  refreshDocument(vscode, collection, document);
  const [diagnostic] = collection.get(document.uri);
  assert.ok(diagnostic.message.split('\n')[0].includes(comparison.inline));
  const parts = getHover(vscode, document, diagnostic);
  assert.equal(parts[1].code, comparison.before);
  assert.equal(parts[3].code, comparison.code);
  assert.equal(parts[4].text, comparison.note);
});

test('a finding with a site fix offers a one-click quick fix that edits only the original lines', async () => {
  const { vscode, collection, root, byUri } = fixture();
  const file = path.join(root, 'orders.ts');
  const text = 'const a = 1;\r\nconst found = await repo.findOne(where);\r\n';
  const edits = [];
  const commands = new Map();
  Object.assign(vscode, {
    CodeAction: class {
      constructor(title, kind) {
        Object.assign(this, { title, kind });
      }
    },
    CodeActionKind: { QuickFix: 'quickfix', SourceFixAll: { append: () => ({ intersects: () => false }) } },
    Disposable: { from: (...items) => items },
    EndOfLine: { LF: 1, CRLF: 2 },
    WorkspaceEdit: class {
      replace(uri, range, newText) {
        edits.push({ uri, range, newText });
      }
    },
    commands: { registerCommand: (id, run) => commands.set(id, run) },
    languages: { registerCodeActionsProvider: (_selector, provider) => provider },
    window: { showWarningMessage() {} },
  });
  vscode.workspace = {
    textDocuments: [],
    openTextDocument: async () => ({ getText: () => text, eol: vscode.EndOfLine.CRLF }),
    applyEdit: async () => true,
  };
  const change = {
    file: 'orders.ts',
    line: 2,
    before: 'const found = await repo.findOne(where);',
    after: 'const found = await repo.exists(where);',
  };
  const finding = { file: 'orders.ts', line: 2, column: 21, ruleId: 'typeorm-existence-materialization', message: 'm' };
  publish(vscode, collection, root, 'backend-perf-check', [
    { ...finding, fix: { changes: [change] } },
    { ...finding, line: 1, fix: { changes: [{ ...change, file: '../outside.ts' }] } },
  ]);
  const provider = registerQuickFixes(vscode, { diagnosticsFor: (uri) => byUri.get(uri) ?? [] }).at(-1);
  const diagnostics = byUri.get(file);
  const actions = provider
    .provideCodeActions({ uri: file }, diagnostics[0].range, {})
    .filter((action) => action.title.startsWith('Apply fix'));
  assert.equal(actions.length, 1, 'a fix that leaves the workspace is dropped');
  assert.equal(actions[0].title, 'Apply fix: typeorm-existence-materialization');
  await commands.get(actions[0].command.command)(...actions[0].command.arguments);
  assert.equal(edits.length, 1);
  assert.deepEqual(
    [edits[0].range.start, edits[0].range.end],
    [
      { line: 1, character: 0 },
      { line: 1, character: change.before.length },
    ],
  );
  assert.equal(edits[0].newText, change.after);
});
