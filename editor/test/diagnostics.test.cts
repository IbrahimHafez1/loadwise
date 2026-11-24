import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  publishFake as publish,
  refreshFakeDocument as refreshDocument,
  registerFakeExamples as registerExamples,
  registerFakeQuickFixes as registerQuickFixes,
} from '../../test/types/fake-vscode.cjs';
import type {
  FakeCodeAction,
  FakeCodeActionProvider,
  FakeDiagnostic,
  FakeDiagnosticCollection,
  FakeDiagnosticEntries,
  FakeDocument,
  FakeHover,
  FakeHoverProvider,
  FakeMarkdownPart,
  FakeMarkdownString,
  FakePosition,
  FakeRange,
  FakeUri,
  FakeVscode,
} from '../../test/types/fake-vscode.cjs';
import { whyComment } from '../../lib/shared/fix-presentation.cjs';

class FakeRangeImpl implements FakeRange {
  start: FakePosition;
  end: FakePosition;
  constructor(line: number, character: number, endLine: number, endCharacter: number) {
    this.start = { line, character };
    this.end = { line: endLine, character: endCharacter };
  }
  contains(position: FakePosition) {
    return (
      this.start.line === position.line &&
      position.character >= this.start.character &&
      position.character <= this.end.character
    );
  }
}

class FakeLocation {
  uri: FakeUri;
  range: FakeRange;
  constructor(uri: FakeUri, range: FakeRange) {
    this.uri = uri;
    this.range = range;
  }
}

class FakeDiagnosticImpl implements FakeDiagnostic {
  range: FakeRange;
  message: string;
  severity: number;
  declare code?: string;
  declare source?: string;
  constructor(range: FakeRange, message: string, severity: number) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

/** The `vscode` fake with the members a scenario adds on top of the base set. */
interface DiagnosticsVscode extends FakeVscode {
  Uri: { file(file: string): FakeUri };
  Range: typeof FakeRangeImpl;
  Location: typeof FakeLocation;
  Diagnostic: typeof FakeDiagnosticImpl;
  workspace: {
    textDocuments: FakeDocument[];
    openTextDocument?(): Promise<{ getText(): string; eol: number }>;
    applyEdit?(): Promise<boolean>;
  };
  MarkdownString?: new () => FakeMarkdownString;
  Hover?: new (contents: FakeMarkdownString[]) => FakeHover;
  languages?: {
    registerHoverProvider?(selector: string, provider: FakeHoverProvider): FakeHoverProvider;
    registerCodeActionsProvider?(selector: string, provider: FakeCodeActionProvider): FakeCodeActionProvider;
  };
  CodeAction?: new (title: string, kind: { value: string }) => FakeCodeAction;
  CodeActionKind?: { QuickFix: string; SourceFixAll: { append(): { intersects(): boolean } } };
  Disposable?: { from(...items: FakeCodeActionProvider[]): FakeCodeActionProvider[] };
  EndOfLine?: { LF: number; CRLF: number };
  WorkspaceEdit?: new () => { replace(uri: FakeUri, range: FakeRange, newText: string): void };
  commands?: { registerCommand(id: string, run: (...args: unknown[]) => unknown): unknown };
  window?: { showWarningMessage(): void };
}

function fixture() {
  const root = path.resolve('example');
  const uri = path.join(root, 'app.py');
  const byUri = new Map<FakeUri, readonly FakeDiagnostic[]>();
  const vscode: DiagnosticsVscode = {
    Uri: { file: (file: string) => file },
    Range: FakeRangeImpl,
    Location: FakeLocation,
    Diagnostic: FakeDiagnosticImpl,
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    workspace: { textDocuments: [] },
  };
  const collection: FakeDiagnosticCollection = {
    forEach: (visit) => {
      for (const key of byUri.keys()) visit(key, byUri.get(key) ?? []);
    },
    get: (key) => byUri.get(key),
    set(entries, diagnostics) {
      const pairs: FakeDiagnosticEntries = typeof entries === 'string' ? [[entries, diagnostics]] : entries;
      for (const [key, current] of pairs) {
        if (current) byUri.set(key, current);
        else byUri.delete(key);
      }
    },
  };
  return { root, uri, vscode, collection, byUri };
}

test('snapshots replace stale markers and discard traversal paths and invalid source locations', () => {
  const { vscode, collection, root, uri, byUri } = fixture();
  const finding = { file: 'app.py', line: 3, column: 2, ruleId: 'file-placement', message: 'Declared policy.' };
  publish(vscode, collection, root, 'loadwise maint', [
    finding,
    { ...finding, file: '../private.py' },
    { ...finding, column: 0 },
  ]);
  assert.equal(byUri.size, 1);
  const [issue] = diagnosticsAt(collection, uri);
  assert.equal(diagnosticsAt(collection, uri).length, 1);
  assert.equal(issue.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(issue.code, finding.ruleId);
  assert.match(issue.message, /Move the file/);
  assert.deepEqual(issue.range.start, { line: 2, character: 1 });
  publish(vscode, collection, root, 'loadwise maint', []);
  assert.equal(byUri.size, 0);
});

test('project rule levels override default contract severity unless an editor severity is set', () => {
  const { vscode, collection, root, uri } = fixture();
  const site = { file: 'app.py', line: 1, column: 1, message: 'Review this operation.' };
  const findings = [
    { ...site, ruleId: 'data-access-boundary' },
    { ...site, ruleId: 'file-placement', level: 'warn' },
    { ...site, ruleId: 'deep-nesting', level: 'error' },
  ];
  const { Error: error, Warning: warning } = vscode.DiagnosticSeverity;
  publish(vscode, collection, root, 'loadwise maint', findings);
  assert.deepEqual(
    diagnosticsAt(collection, uri).map((diagnostic) => diagnostic.severity),
    [error, warning, error],
  );
  publish(vscode, collection, root, 'loadwise maint', findings, { severity: 'warning' });
  assert.ok(diagnosticsAt(collection, uri).every((diagnostic) => diagnostic.severity === warning));
});

function diagnosticsAt(collection: FakeDiagnosticCollection, key: FakeUri): readonly FakeDiagnostic[] {
  const diagnostics = collection.get(key);
  assert.ok(diagnostics, 'expected diagnostics for ' + key);
  return diagnostics;
}

function getHover(vscode: DiagnosticsVscode, document: FakeDocument, diagnostic: FakeDiagnostic) {
  vscode.MarkdownString = class {
    parts: FakeMarkdownPart[] = [];
    appendText(text: string) {
      this.parts.push({ text });
    }
    appendCodeblock(code: string, language: string) {
      this.parts.push({ code, language });
    }
  };
  vscode.Hover = class {
    contents: FakeMarkdownString[];
    constructor(contents: FakeMarkdownString[]) {
      this.contents = contents;
    }
  };
  vscode.languages = {
    registerHoverProvider: (_selector: string, provider: FakeHoverProvider) => provider,
  };
  return registerExamples(vscode, () => [diagnostic]).provideHover(document, diagnostic.range.start).contents[0].parts;
}

test('opening a saved file shows the actual before and suggested after in its hover', () => {
  const { vscode, collection, root } = fixture();
  const text = 'return required.every((key) => held.includes(key));';
  const document: FakeDocument = {
    uri: path.join(root, 'permissions.ts'),
    languageId: 'typescript',
    lineCount: 1,
    lineAt: () => ({ text }),
    validateRange: (range: FakeRange) => range,
    getWordRangeAtPosition: () => undefined,
  };
  const finding = {
    file: 'permissions.ts',
    line: 1,
    column: text.indexOf('includes') + 1,
    ruleId: 'array-repeated-membership',
    message: 'Membership checks repeatedly scan the same array.',
  };
  publish(vscode, collection, root, 'loadwise perf', [finding]);
  refreshDocument(vscode, collection, document);
  const [diagnostic] = diagnosticsAt(collection, document.uri);
  assert.ok(diagnostic.message.endsWith(finding.message));
  const parts = getHover(vscode, document, diagnostic);
  assert.match(String(parts[0].text), /Current code/);
  assert.deepEqual(parts[1], { code: text, language: 'typescript' });
  assert.equal(parts[2].text, 'Suggested rewrite');
  assert.match(String(parts[3].code), /heldSet\.has\(key\)/);
  assert.match(String(parts[4].text), /stable/);
  const originalPreview = diagnostic.message;
  refreshDocument(vscode, collection, document);
  assert.equal(diagnostic.message, originalPreview);
  document.isDirty = true;
  assert.match(String(getHover(vscode, document, diagnostic)[0]?.text), /Illustrative alternative/);
});

test('a short nested-control-flow rewrite appears before the explanation on the diagnostic itself', () => {
  const { vscode, collection, root } = fixture();
  const uri = path.join(root, 'pipeline.ts');
  const text = '    if (!startTime) startTime = new Date();';
  const document: FakeDocument = {
    uri,
    lineCount: 1,
    languageId: 'typescript',
    lineAt: () => ({ text }),
    validateRange: (range: FakeRange) => range,
    getWordRangeAtPosition: () => undefined,
  };
  vscode.workspace.textDocuments.push(document);
  const message = 'Control flow reaches 4 nested levels.';
  publish(vscode, collection, root, 'loadwise maint', [
    { file: 'pipeline.ts', line: 1, column: 5, ruleId: 'deep-control-flow', message },
  ]);
  const [diagnostic] = diagnosticsAt(collection, uri);
  assert.deepEqual(diagnostic.message.split('\n'), ['Code: ' + text.trim() + ' → startTime ||= new Date();', message]);
  const parts = getHover(vscode, document, diagnostic);
  assert.equal(parts[1].code, text.trim());
  assert.equal(parts[3].code, 'startTime ||= new Date();');
  assert.match(String(parts[4].text), /falsy/);
  refreshDocument(vscode, collection, document);
  assert.equal(diagnostic.message.split('\n').length, 2);
});

test('an advisory without a verified rewrite labels the reported line and illustrative example separately', () => {
  const { vscode, collection, root, uri } = fixture();
  const text = '    if should_retry(job):';
  const document: FakeDocument = {
    uri,
    languageId: 'python',
    lineCount: 1,
    lineAt: () => ({ text }),
    validateRange: (range: FakeRange) => range,
    getWordRangeAtPosition: () => undefined,
  };
  vscode.workspace.textDocuments.push(document);
  publish(vscode, collection, root, 'loadwise maint', [
    {
      file: 'app.py',
      line: 1,
      column: 5,
      ruleId: 'deep-control-flow',
      message: 'Control flow reaches 4 nested levels.',
    },
  ]);
  const [diagnostic] = diagnosticsAt(collection, uri);
  const parts = getHover(vscode, document, diagnostic);
  assert.match(String(parts[0].text), /Flagged line/);
  assert.equal(parts[1].code?.trim(), text.trim());
  assert.equal(parts[2].text, 'Illustrative alternative');
  assert.equal(parts[3].language, 'python');
  assert.match(String(parts[3].code), /continue/);
  assert.ok(parts[4].text);
});

test('opening a polyglot file converts columns after astral characters to editor UTF-16 positions', () => {
  const { vscode, collection, root, uri } = fixture();
  const line = 'label = "😀"; process()';
  const character = line.indexOf('process');
  const column = Array.from(line.slice(0, character)).length + 1;
  publish(vscode, collection, root, 'loadwise perf', [
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
  assert.equal(diagnosticsAt(collection, uri)[0].range.start.character, character);
});

test('scanner review advice survives reopening and provides a single flagged snippet without an unrelated rewrite', () => {
  const { vscode, collection, root } = fixture();
  const text = 'function load(scope) {';
  const document: FakeDocument = {
    uri: path.join(root, 'service.ts'),
    languageId: 'typescript',
    lineCount: 1,
    lineAt: () => ({ text }),
    validateRange: (range: FakeRange) => range,
    getWordRangeAtPosition: () => undefined,
  };
  const suggestion = 'Extract the shared input checks after comparing both callers.';
  publish(vscode, collection, root, 'loadwise maint', [
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
  const [diagnostic] = diagnosticsAt(collection, document.uri);
  assert.equal(diagnostic.message.split('\n')[0], 'Review: ' + suggestion);
  const parts = getHover(vscode, document, diagnostic);
  assert.deepEqual(
    parts.filter((part) => part.code !== undefined),
    [{ code: text, language: 'typescript' }],
  );
  assert.equal(parts.at(-1)?.text, 'Review: ' + suggestion);
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
  const document: FakeDocument = {
    uri: path.join(root, 'loop.ts'),
    languageId: 'typescript',
    lineCount: lines.length,
    lineAt: (index: number) => ({ text: lines[index] }),
    validateRange: (range: FakeRange) => range,
    getWordRangeAtPosition: () => undefined,
  };
  publish(vscode, collection, root, 'loadwise maint', [
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
  const [diagnostic] = diagnosticsAt(collection, document.uri);
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
  const crlf = 2;
  const edits: { uri: FakeUri; range: FakeRange; newText: string }[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  Object.assign(vscode, {
    CodeAction: class {
      declare title: string;
      declare kind: { value: string };
      constructor(title: string, kind: { value: string }) {
        Object.assign(this, { title, kind });
      }
    },
    CodeActionKind: { QuickFix: 'quickfix', SourceFixAll: { append: () => ({ intersects: () => false }) } },
    Disposable: { from: (...items: FakeCodeActionProvider[]) => items },
    EndOfLine: { LF: 1, CRLF: 2 },
    WorkspaceEdit: class {
      replace(uri: FakeUri, range: FakeRange, newText: string) {
        edits.push({ uri, range, newText });
      }
    },
    commands: { registerCommand: (id: string, run: (...args: unknown[]) => unknown) => commands.set(id, run) },
    languages: { registerCodeActionsProvider: (_selector: string, provider: FakeCodeActionProvider) => provider },
    window: { showWarningMessage() {} },
  });
  vscode.workspace = {
    textDocuments: [],
    openTextDocument: async () => ({ getText: () => text, eol: crlf }),
    applyEdit: async () => true,
  };
  const change = {
    file: 'orders.ts',
    line: 2,
    before: 'const found = await repo.findOne(where);',
    after: 'const found = await repo.exists(where);',
  };
  const finding = { file: 'orders.ts', line: 2, column: 21, ruleId: 'typeorm-existence-materialization', message: 'm' };
  // The quick fix writes the report's why-comment, like a default --fix.
  const commented = { ...change, after: whyComment(finding.ruleId) + '\n' + change.after };
  publish(vscode, collection, root, 'loadwise perf', [
    { ...finding, fix: { changes: [commented] } },
    { ...finding, line: 1, fix: { changes: [{ ...change, file: '../outside.ts' }] } },
  ]);
  const provider = registerQuickFixes(vscode, { diagnosticsFor: (uri) => byUri.get(uri) ?? [] }).at(-1);
  const diagnostics = byUri.get(file);
  assert.ok(provider && diagnostics?.[0]);
  const provided = await provider.provideCodeActions({ uri: file }, diagnostics[0].range, {});
  const actions = provided.filter((action) => action.title.startsWith('Apply fix'));
  assert.equal(actions.length, 1, 'a fix that leaves the workspace is dropped');
  assert.equal(actions[0].title, 'Apply fix: typeorm-existence-materialization');
  const command = actions[0]?.command;
  assert.ok(command);
  await commands.get(command.command)?.(...command.arguments);
  assert.equal(edits.length, 1);
  assert.deepEqual(
    [edits[0].range.start, edits[0].range.end],
    [
      { line: 1, character: 0 },
      { line: 1, character: change.before.length },
    ],
  );
  assert.equal(edits[0].newText.replaceAll('\r\n', '\n'), commented.after);
});
