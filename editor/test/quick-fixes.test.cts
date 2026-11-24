import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  publishFake as publish,
  registerFakeCodeLenses as registerCodeLenses,
  registerFakeQuickFixes as registerQuickFixes,
} from '../../test/types/fake-vscode.cjs';
import { createDismissals } from '../dismissals.cjs';
import type { Finding, FindingFix } from '../../lib/shared/types.cjs';
import type { Memento } from '../types/dismissal.cjs';
import type {
  FakeCodeActionProvider,
  FakeCodeLens,
  FakeCommand,
  FakeCodeLensProvider,
  FakeDiagnostic,
  FakeDiagnosticCollection,
  FakeDiagnosticEntries,
  FakeDocument,
  FakeEditOperation,
  FakePosition,
  FakeRange,
  FakeUri,
  FakeVscode,
  FakeWorkspaceEdit,
} from '../../test/types/fake-vscode.cjs';

const root = path.resolve('example');
const ordersFile = path.join(root, 'orders.ts');

class Range implements FakeRange {
  start: FakePosition;
  end: FakePosition;
  constructor(line: number, character: number, endLine: number, endCharacter: number) {
    this.start = { line, character };
    this.end = { line: endLine, character: endCharacter };
  }
}

interface FakeKind {
  value: string;
  append(part: string): FakeKind;
  intersects(other: FakeKind): boolean;
}

function kind(value: string): FakeKind {
  return {
    value,
    append: (part: string) => kind(value + '.' + part),
    intersects: (other: FakeKind) => value.startsWith(other.value) || other.value.startsWith(value),
  };
}

type CommandHandler = (...args: unknown[]) => unknown;

interface ActiveEditor {
  document: { uri: FakeUri };
  selection: { active: { line: number } };
}

interface EditorFakeVscode extends FakeVscode {
  Uri: { file(file: string): FakeUri };
  DiagnosticSeverity: Record<string, number>;
  Range: typeof Range;
  Position: new (line: number, character: number) => FakePosition;
  Location: new (uri: FakeUri, range: FakeRange) => object;
  Diagnostic: new (range: FakeRange, message: string, severity: number) => object;
  CodeAction: new (title: string, kind: FakeKind) => object;
  Disposable: { from(...items: FakeCodeActionProvider[]): FakeCodeActionProvider[] };
  EndOfLine: { LF: number; CRLF: number };
  WorkspaceEdit: typeof FakeEdit;
  CodeActionKind: { QuickFix: FakeKind; SourceFixAll: FakeKind };
  commands: {
    registerCommand(id: string, run: CommandHandler): string;
    executeCommand?(id: string, ...args: unknown[]): unknown;
  };
  languages: {
    registerCodeActionsProvider(selector: string, provider: FakeCodeActionProvider): FakeCodeActionProvider;
    registerCodeLensProvider?(selector: string, provider: FakeCodeLensProvider): FakeCodeLensProvider;
  };
  window: {
    activeTextEditor?: ActiveEditor;
    showWarningMessage(text: string): void;
    showInformationMessage(text: string): void;
  };
  workspace: {
    textDocuments: FakeDocument[];
    openTextDocument(uri: FakeUri): Promise<{ getText(): string | undefined; eol: number }>;
    fs: { readFile(uri: FakeUri): Promise<Uint8Array> };
    applyEdit(edit: FakeEdit): Promise<number>;
    getConfiguration?(): { get(key: string, fallback: unknown): unknown };
  };
  EventEmitter?: new () => { event: () => { dispose(): void }; fire(): void; dispose(): void };
  CodeLens?: new (range: FakeRange, command: FakeCommand) => FakeCodeLens;
}

class FakeEdit implements FakeWorkspaceEdit {
  operations: FakeEditOperation[] = [];
  replace(uri: FakeUri, range: FakeRange, text: string) {
    this.operations.push({ type: 'replace', uri, line: range.start.line, text });
  }
  createFile(uri: FakeUri, options: { ignoreIfExists: boolean }) {
    this.operations.push({ type: 'createFile', uri, options });
  }
  insert(uri: FakeUri, position: FakePosition, text: string) {
    this.operations.push({ type: 'insert', uri, line: position.line, text });
  }
}

function fakeEditor(files: Map<string, string>) {
  const commands = new Map<string, CommandHandler>();
  const messages: [string, string][] = [];
  const appliedEdits: FakeEdit[] = [];
  const vscode: EditorFakeVscode = {
    Uri: { file: (file: string) => file },
    Range,
    Position: class {
      declare line: number;
      declare character: number;
      constructor(line: number, character: number) {
        Object.assign(this, { line, character });
      }
    },
    Location: class {
      constructor(uri: FakeUri, range: FakeRange) {
        Object.assign(this, { uri, range });
      }
    },
    Diagnostic: class {
      constructor(range: FakeRange, message: string, severity: number) {
        Object.assign(this, { range, message, severity });
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeAction: class {
      constructor(title: string, actionKind: FakeKind) {
        Object.assign(this, { title, kind: actionKind });
      }
    },
    CodeActionKind: { QuickFix: kind('quickfix'), SourceFixAll: kind('source.fixAll') },
    Disposable: { from: (...items: FakeCodeActionProvider[]) => items },
    EndOfLine: { LF: 1, CRLF: 2 },
    WorkspaceEdit: FakeEdit,
    commands: {
      registerCommand: (id: string, run: CommandHandler) => (commands.set(id, run), id),
    },
    languages: {
      registerCodeActionsProvider: (_selector: string, provider: FakeCodeActionProvider) => provider,
    },
    window: {
      showWarningMessage: (text: string) => messages.push(['warning', text]),
      showInformationMessage: (text: string) => messages.push(['information', text]),
    },
    workspace: {
      textDocuments: [],
      openTextDocument: async (uri: FakeUri) => ({ getText: () => files.get(uri), eol: 1 }),
      fs: {
        readFile: async (uri: FakeUri) => {
          const text = files.get(uri);
          if (text === undefined) throw new Error('missing');
          return new TextEncoder().encode(text);
        },
      },
      applyEdit: async (edit: FakeEdit) => appliedEdits.push(edit),
    },
  };
  const byUri = new Map<FakeUri, readonly FakeDiagnostic[]>();
  const collection: FakeDiagnosticCollection = {
    forEach: (visit) => byUri.forEach((list, uri) => visit(uri, list)),
    get: (uri) => byUri.get(uri),
    set(entries) {
      const pairs: FakeDiagnosticEntries = typeof entries === 'string' ? [] : entries;
      for (const [uri, list] of pairs) {
        if (list) byUri.set(uri, list);
        else byUri.delete(uri);
      }
    },
  };
  // Open, saved documents back the flagged-line text that dismissals are keyed on.
  function open(file: string) {
    const lines = (files.get(file) ?? '').split('\n');
    vscode.workspace.textDocuments = vscode.workspace.textDocuments.filter((document) => document.uri !== file);
    vscode.workspace.textDocuments.push({
      uri: file,
      languageId: 'typescript',
      isDirty: false,
      lineCount: lines.length,
      lineAt: (line: number) => ({ text: lines[line] ?? '' }),
      validateRange: (range: FakeRange) => range,
      getWordRangeAtPosition: () => undefined,
    });
  }
  return { vscode, commands, messages, appliedEdits, byUri, collection, open };
}

async function runCommand(commands: Map<string, CommandHandler>, id: string, ...args: unknown[]) {
  const handler = commands.get(id);
  assert.ok(handler, 'no command ' + id);
  return handler(...args);
}

function diagnosticsOf(byUri: Map<FakeUri, readonly FakeDiagnostic[]>, file: FakeUri): readonly FakeDiagnostic[] {
  const diagnostics = byUri.get(file);
  assert.ok(diagnostics, 'expected diagnostics for ' + file);
  return diagnostics;
}

function lastProvider(providers: FakeCodeActionProvider[]): FakeCodeActionProvider {
  const provider = providers.at(-1);
  assert.ok(provider, 'expected the code action provider');
  return provider;
}

function memento(): Memento {
  const values = new Map<string, unknown>();
  function read(key: string): unknown;
  function read<Value>(key: string, fallback: Value): Value;
  function read(key: string, fallback?: unknown): unknown {
    return values.get(key) ?? fallback;
  }
  return {
    get: read,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

const finding = (line: number, ruleId = 'array-repeated-membership') => ({
  file: 'orders.ts',
  line,
  column: 3,
  ruleId,
  message: 'Example finding.',
});

test('the severity setting applies to every finding; by default contracts are errors and the rest warnings', () => {
  const files = new Map([[ordersFile, 'a();\nb();']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  const findings = [finding(1), finding(2, 'pg-transaction-on-pool')];
  publish(editor.vscode, editor.collection, root, 'loadwise perf', findings);
  assert.deepEqual(
    diagnosticsOf(editor.byUri, ordersFile).map((diagnostic) => diagnostic.severity),
    [editor.vscode.DiagnosticSeverity.Warning, editor.vscode.DiagnosticSeverity.Error],
  );
  publish(editor.vscode, editor.collection, root, 'loadwise perf', findings, { severity: 'hint' });
  assert.deepEqual(
    diagnosticsOf(editor.byUri, ordersFile).map((diagnostic) => diagnostic.severity),
    [editor.vscode.DiagnosticSeverity.Hint, editor.vscode.DiagnosticSeverity.Hint],
  );
});

test('a dismissed finding stays hidden across rescans and line shifts and returns once its line changes', async () => {
  const files = new Map([[ordersFile, 'const held = list();\nif (held.includes(key)) run();']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  const dismissals = createDismissals(memento());
  let findings = [finding(2), finding(1, 'sync-io')];
  const republish = () =>
    publish(editor.vscode, editor.collection, root, 'loadwise perf', findings, {
      isDismissed: (site) => dismissals.has(site),
    });
  republish();
  const provider = lastProvider(
    registerQuickFixes(editor.vscode, {
      diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [],
      dismissals,
      onDismissed: republish,
    }),
  );
  // The cursor sits at the end of the flagged line, away from the reported token.
  const actions = provider.provideCodeActions({ uri: ordersFile }, new Range(1, 30, 1, 30), {});
  assert.deepEqual(
    actions.map((action) => action.title),
    ['Dismiss this finding (array-repeated-membership)', 'Dismiss array-repeated-membership in this file'],
  );
  await runCommand(editor.commands, actions[0].command.command, ...actions[0].command.arguments);
  assert.deepEqual(
    diagnosticsOf(editor.byUri, ordersFile).map((diagnostic) => diagnostic.code),
    ['sync-io'],
  );

  files.set(ordersFile, '// header\n\nconst held = list();\nif (held.includes(key)) run();');
  editor.open(ordersFile);
  findings = [finding(4), finding(3, 'sync-io')];
  republish();
  assert.equal(diagnosticsOf(editor.byUri, ordersFile).length, 1, 'a line shift keeps the finding dismissed');

  files.set(ordersFile, '// header\n\nconst held = list();\nif (held.includes(other)) run();');
  editor.open(ordersFile);
  republish();
  assert.equal(diagnosticsOf(editor.byUri, ordersFile).length, 2, 'changed code shows the finding again');

  const [, fileWide] = provider.provideCodeActions({ uri: ordersFile }, new Range(3, 0, 3, 0), {});
  await runCommand(editor.commands, fileWide.command.command, ...fileWide.command.arguments);
  findings = [finding(4), finding(1), finding(3, 'sync-io')];
  republish();
  assert.deepEqual(
    diagnosticsOf(editor.byUri, ordersFile).map((diagnostic) => diagnostic.code),
    ['sync-io'],
  );
  await dismissals.remove(dismissals.entries());
  republish();
  assert.equal(diagnosticsOf(editor.byUri, ordersFile).length, 3, 'restoring every dismissal shows all findings again');
});

const fixed = (line: number, before: string, after: string): Finding & { fix: FindingFix } => ({
  ...finding(line),
  fix: { changes: [{ file: 'orders.ts', line, before, after }] },
});

test('apply all fixes builds one edit and skips stale and overlapping fixes', async () => {
  const files = new Map([[ordersFile, 'one();\ntwo();\nthree();\nfour();']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  publish(editor.vscode, editor.collection, root, 'loadwise perf', [
    fixed(1, 'one();', 'ONE();'),
    fixed(2, 'two();\nthree();', 'TWO_THREE();'),
    fixed(3, 'three();', 'THREE();'),
    fixed(4, 'gone();', 'GONE();'),
  ]);
  const disposables = registerQuickFixes(editor.vscode, { diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [] });
  const provider = lastProvider(disposables);
  const lineActions = provider.provideCodeActions({ uri: ordersFile }, new Range(0, 0, 0, 0), {});
  const applyAll = lineActions.find((action) => action.title === 'Apply all Loadwise fixes in this file');
  assert.ok(applyAll);
  await runCommand(editor.commands, applyAll.command.command, ...applyAll.command.arguments);
  assert.equal(editor.appliedEdits.length, 1, 'one edit means one undo');
  assert.deepEqual(
    editor.appliedEdits[0].operations.map(({ line, text }) => [line, text]),
    [
      [0, 'ONE();'],
      [1, 'TWO_THREE();'],
    ],
  );
  assert.deepEqual(editor.messages, [
    ['warning', 'Loadwise applied 2 fix(es); skipped 2 stale, overlapping or existing-file fix(es).'],
  ]);

  const [fixAll] = await provider.provideCodeActions({ uri: ordersFile }, new Range(0, 0, 0, 0), {
    only: editor.vscode.CodeActionKind.SourceFixAll,
  });
  assert.equal(fixAll.kind.value, 'source.fixAll.loadwise');
  assert.equal(fixAll.edit.operations.length, 2, 'the fix-all action carries its edit for code actions on save');
});

test('bulk and on-save actions reserve review-only edits for explicit individual Apply', async () => {
  const editor = fakeEditor(new Map([[ordersFile, 'one();\ntwo();']]));
  const safe = fixed(1, 'one();', 'ONE();');
  const reviewed = fixed(2, 'two();', 'TWO();');
  reviewed.fix.requiresReview = true;
  const duplicate = fixed(2, 'two();', 'TWO();');
  publish(editor.vscode, editor.collection, root, 'loadwise perf', [safe, reviewed, duplicate]);
  const provider = lastProvider(
    registerQuickFixes(editor.vscode, { diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [] }),
  );
  const document = { uri: ordersFile };
  const line = new Range(1, 0, 1, 0);
  await runCommand(editor.commands, 'loadwise.applyAllFixes', ordersFile);
  assert.deepEqual(
    editor.appliedEdits[0].operations.map(({ text }) => text),
    ['ONE();'],
  );
  assert.match(editor.messages[0][1], /1 fix\(es\) require individual review/);
  const onSave = { only: editor.vscode.CodeActionKind.SourceFixAll };
  const [action] = await provider.provideCodeActions(document, line, onSave);
  assert.deepEqual(
    action.edit.operations.map(({ text }) => text),
    ['ONE();'],
  );

  publish(editor.vscode, editor.collection, root, 'loadwise perf', [reviewed]);
  assert.deepEqual(await provider.provideCodeActions(document, line, onSave), []);
  const [individual] = provider.provideCodeActions(document, line, {});
  assert.equal(individual.isPreferred, false);
  await runCommand(editor.commands, individual.command.command, ...individual.command.arguments);
  assert.deepEqual(
    editor.appliedEdits[1].operations.map(({ text }) => text),
    ['TWO();'],
  );
});

test('a fix that creates a file applies with its other changes, and never overwrites an existing file', async () => {
  const migration = path.join(root, 'migrations', '001_orders_index.sql');
  const files = new Map([[ordersFile, 'await repo.find({ where: { customerId } });']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  const create = {
    file: 'migrations/001_orders_index.sql',
    line: 1,
    before: '',
    after: 'CREATE INDEX orders_customer_id ON orders (customer_id);\n',
    create: true,
  };
  const replace = {
    file: 'orders.ts',
    line: 1,
    before: files.get(ordersFile) ?? '',
    after: '// indexed\n' + files.get(ordersFile),
  };
  publish(editor.vscode, editor.collection, root, 'loadwise perf', [
    { ...finding(1), fix: { changes: [create, replace], note: 'Adds the missing index.' } },
  ]);
  const provider = lastProvider(
    registerQuickFixes(editor.vscode, { diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [] }),
  );
  const [apply] = provider.provideCodeActions({ uri: ordersFile }, new Range(0, 0, 0, 0), {});
  assert.equal(apply.title, 'Apply fix: array-repeated-membership');
  await runCommand(editor.commands, apply.command.command, ...apply.command.arguments);
  assert.deepEqual(
    editor.appliedEdits[0].operations.map(({ type, uri }) => [type, uri]),
    [
      ['createFile', migration],
      ['insert', migration],
      ['replace', ordersFile],
    ],
  );
  assert.deepEqual(editor.appliedEdits[0].operations[0].options, { ignoreIfExists: false });

  files.set(migration, create.after.replace('\n', '\r\n'));
  await runCommand(editor.commands, apply.command.command, ...apply.command.arguments);
  assert.deepEqual(
    editor.appliedEdits[1].operations.map(({ type }) => type),
    ['replace'],
    'a file that already has this content is kept and the rest of the fix still applies',
  );

  files.set(migration, '-- written by hand');
  await runCommand(editor.commands, apply.command.command, ...apply.command.arguments);
  assert.equal(editor.appliedEdits.length, 2, 'a file with other content blocks the whole fix');
  assert.match(String(editor.messages.at(-1)?.[1]), /001_orders_index\.sql already exists/);
});

test('a live-database finding without a file shows on package.json with its table and fix', () => {
  const packageFile = path.join(root, 'package.json');
  const editor = fakeEditor(new Map([[packageFile, '{\n  "name": "example"\n}']]));
  editor.open(packageFile);
  const migration = { file: 'migrations/002.sql', line: 1, before: '', after: 'CREATE INDEX ...;\n', create: true };
  publish(editor.vscode, editor.collection, root, 'loadwise perf', [
    {
      ruleId: 'db-missing-fk-index',
      target: 'public.orders',
      message: 'Foreign key has no index.',
      fix: { changes: [migration] },
    },
  ]);
  const [diagnostic] = diagnosticsOf(editor.byUri, packageFile);
  assert.deepEqual(diagnostic.range.start, { line: 0, character: 0 });
  assert.equal(
    diagnostic.message,
    'Code: (new file migrations/002.sql) → CREATE INDEX ...;\npublic.orders: Foreign key has no index.',
  );
  const provider = lastProvider(
    registerQuickFixes(editor.vscode, { diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [] }),
  );
  const [apply, dismiss] = provider.provideCodeActions({ uri: packageFile }, new Range(0, 0, 0, 0), {});
  assert.equal(apply.title, 'Apply fix: db-missing-fk-index');
  const dismissal = dismiss.command.arguments[0];
  assert.ok(typeof dismissal === 'object' && dismissal !== null && 'lineText' in dismissal);
  assert.equal(dismissal.lineText, 'public.orders', 'dismissed by table, not by package.json text');
});

test('code lenses put Apply fix and Dismiss buttons on fixable lines and an apply-all button at the top', () => {
  const files = new Map([[ordersFile, 'one();\ntwo();\nthree();']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  let provider: FakeCodeLensProvider | undefined;
  editor.vscode.EventEmitter = class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  };
  editor.vscode.CodeLens = class {
    declare range: FakeRange;
    declare command: FakeCommand;
    constructor(range: FakeRange, command: FakeCommand) {
      Object.assign(this, { range, command });
    }
  };
  editor.vscode.languages.registerCodeLensProvider = (_selector: string, registered: FakeCodeLensProvider) =>
    (provider = registered);
  editor.vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  publish(editor.vscode, editor.collection, root, 'loadwise perf', [
    fixed(1, 'one();', 'ONE();'),
    finding(2),
    fixed(3, 'three();', 'THREE();'),
  ]);
  registerCodeLenses(editor.vscode, (uri) => editor.byUri.get(uri) ?? []);
  assert.ok(provider);
  const lenses = provider.provideCodeLenses({ uri: ordersFile });
  assert.deepEqual(
    lenses.map((lens) => [lens.range.start.line, lens.command.title]),
    [
      [0, '$(wrench) Apply all 2 Loadwise fixes in this file'],
      [0, '$(wrench) Apply fix: array-repeated-membership'],
      [0, 'Dismiss'],
      [2, '$(wrench) Apply fix: array-repeated-membership'],
      [2, 'Dismiss'],
    ],
  );
  editor.vscode.workspace.getConfiguration = () => ({ get: () => false });
  assert.deepEqual(provider.provideCodeLenses({ uri: ordersFile }), [], 'the codeLens setting turns them off');
});

test('a finding message shows one sentence per line and keeps code spans and abbreviations whole', () => {
  const files = new Map([[ordersFile, 'one();']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  const message = 'Each call is slow. Use `a.b(). Then` instead, e.g. a batch. Keep it otherwise.';
  publish(editor.vscode, editor.collection, root, 'loadwise perf', [{ ...finding(1), message }]);
  // The first line is the code preview of the open document.
  assert.deepEqual(diagnosticsOf(editor.byUri, ordersFile)[0].message.split('\n').slice(1), [
    'Each call is slow.',
    'Use `a.b(). Then` instead, e.g. a batch.',
    'Keep it otherwise.',
  ]);
});

test('the keyboard command applies the fix on the cursor line, and says so when the line has none', async () => {
  const files = new Map([[ordersFile, 'one();\ntwo();']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  editor.vscode.commands.executeCommand = (id: string, ...args) => runCommand(editor.commands, id, ...args);
  publish(editor.vscode, editor.collection, root, 'loadwise perf', [fixed(1, 'one();', 'ONE();'), finding(2)]);
  registerQuickFixes(editor.vscode, { diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [] });
  const cursorOn = (line: number) => {
    editor.vscode.window.activeTextEditor = { document: { uri: ordersFile }, selection: { active: { line } } };
  };
  cursorOn(0);
  await runCommand(editor.commands, 'loadwise.applyFixAtCursor');
  assert.deepEqual(
    editor.appliedEdits[0].operations.map(({ type, text }) => [type, text]),
    [['replace', 'ONE();']],
  );
  cursorOn(1);
  await runCommand(editor.commands, 'loadwise.applyFixAtCursor');
  assert.equal(editor.appliedEdits.length, 1);
  assert.deepEqual(editor.messages.at(-1), ['information', 'Loadwise has no fix on this line.']);
});
