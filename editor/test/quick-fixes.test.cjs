'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { publish, registerQuickFixes } = require('../diagnostics.cjs');
const { createDismissals } = require('../dismissals.cjs');

const root = path.resolve('example');
const ordersFile = path.join(root, 'orders.ts');

class Range {
  constructor(line, character, endLine, endCharacter) {
    this.start = { line, character };
    this.end = { line: endLine, character: endCharacter };
  }
}

function kind(value) {
  return {
    value,
    append: (part) => kind(value + '.' + part),
    intersects: (other) => value.startsWith(other.value) || other.value.startsWith(value),
  };
}

function fakeEditor(files) {
  const commands = new Map();
  const messages = [];
  const appliedEdits = [];
  const vscode = {
    Uri: { file: (file) => file },
    Range,
    Position: class {
      constructor(line, character) {
        Object.assign(this, { line, character });
      }
    },
    Location: class {
      constructor(uri, range) {
        Object.assign(this, { uri, range });
      }
    },
    Diagnostic: class {
      constructor(range, message, severity) {
        Object.assign(this, { range, message, severity });
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeAction: class {
      constructor(title, actionKind) {
        Object.assign(this, { title, kind: actionKind });
      }
    },
    CodeActionKind: { QuickFix: kind('quickfix'), SourceFixAll: kind('source.fixAll') },
    Disposable: { from: (...items) => items },
    EndOfLine: { LF: 1, CRLF: 2 },
    WorkspaceEdit: class {
      operations = [];
      replace(uri, range, text) {
        this.operations.push({ type: 'replace', uri, line: range.start.line, text });
      }
      createFile(uri, options) {
        this.operations.push({ type: 'createFile', uri, options });
      }
      insert(uri, position, text) {
        this.operations.push({ type: 'insert', uri, line: position.line, text });
      }
    },
    commands: { registerCommand: (id, run) => commands.set(id, run) && id },
    languages: { registerCodeActionsProvider: (_selector, provider) => provider },
    window: {
      showWarningMessage: (text) => messages.push(['warning', text]),
      showInformationMessage: (text) => messages.push(['information', text]),
    },
    workspace: {
      textDocuments: [],
      openTextDocument: async (uri) => ({ getText: () => files.get(uri), eol: 1 }),
      fs: {
        readFile: async (uri) => {
          if (!files.has(uri)) throw new Error('missing');
          return new TextEncoder().encode(files.get(uri));
        },
      },
      applyEdit: async (edit) => appliedEdits.push(edit),
    },
  };
  const byUri = new Map();
  const collection = {
    forEach: (visit) => byUri.forEach((list, uri) => visit(uri, list)),
    get: (uri) => byUri.get(uri),
    set(entries) {
      for (const [uri, list] of entries) {
        if (list) byUri.set(uri, list);
        else byUri.delete(uri);
      }
    },
  };
  // Open, saved documents back the flagged-line text that dismissals are keyed on.
  function open(file) {
    const lines = files.get(file).split('\n');
    vscode.workspace.textDocuments = vscode.workspace.textDocuments.filter((document) => document.uri !== file);
    vscode.workspace.textDocuments.push({
      uri: file,
      languageId: 'typescript',
      isDirty: false,
      lineCount: lines.length,
      lineAt: (line) => ({ text: lines[line] }),
      validateRange: (range) => range,
      getWordRangeAtPosition: () => undefined,
    });
  }
  return { vscode, commands, messages, appliedEdits, byUri, collection, open };
}

function memento() {
  const values = new Map();
  return { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) };
}

const finding = (line, ruleId = 'array-repeated-membership') => ({
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
  publish(editor.vscode, editor.collection, root, 'backend-perf-check', findings);
  assert.deepEqual(
    editor.byUri.get(ordersFile).map((diagnostic) => diagnostic.severity),
    [editor.vscode.DiagnosticSeverity.Warning, editor.vscode.DiagnosticSeverity.Error],
  );
  publish(editor.vscode, editor.collection, root, 'backend-perf-check', findings, { severity: 'hint' });
  assert.deepEqual(
    editor.byUri.get(ordersFile).map((diagnostic) => diagnostic.severity),
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
    publish(editor.vscode, editor.collection, root, 'backend-perf-check', findings, {
      isDismissed: (site) => dismissals.has(site),
    });
  republish();
  const provider = registerQuickFixes(editor.vscode, {
    diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [],
    dismissals,
    onDismissed: republish,
  }).at(-1);
  // The cursor sits at the end of the flagged line, away from the reported token.
  const actions = provider.provideCodeActions({ uri: ordersFile }, new Range(1, 30, 1, 30), {});
  assert.deepEqual(
    actions.map((action) => action.title),
    ['Dismiss this finding (array-repeated-membership)', 'Dismiss array-repeated-membership in this file'],
  );
  await editor.commands.get(actions[0].command.command)(...actions[0].command.arguments);
  assert.deepEqual(
    editor.byUri.get(ordersFile).map((diagnostic) => diagnostic.code),
    ['sync-io'],
  );

  files.set(ordersFile, '// header\n\nconst held = list();\nif (held.includes(key)) run();');
  editor.open(ordersFile);
  findings = [finding(4), finding(3, 'sync-io')];
  republish();
  assert.equal(editor.byUri.get(ordersFile).length, 1, 'a line shift keeps the finding dismissed');

  files.set(ordersFile, '// header\n\nconst held = list();\nif (held.includes(other)) run();');
  editor.open(ordersFile);
  republish();
  assert.equal(editor.byUri.get(ordersFile).length, 2, 'changed code shows the finding again');

  const [, fileWide] = provider.provideCodeActions({ uri: ordersFile }, new Range(3, 0, 3, 0), {});
  await editor.commands.get(fileWide.command.command)(...fileWide.command.arguments);
  findings = [finding(4), finding(1), finding(3, 'sync-io')];
  republish();
  assert.deepEqual(
    editor.byUri.get(ordersFile).map((diagnostic) => diagnostic.code),
    ['sync-io'],
  );
  await dismissals.remove(dismissals.entries());
  republish();
  assert.equal(editor.byUri.get(ordersFile).length, 3, 'restoring every dismissal shows all findings again');
});

const fixed = (line, before, after) => ({
  ...finding(line),
  fix: { changes: [{ file: 'orders.ts', line, before, after }] },
});

test('apply all fixes builds one edit and skips stale and overlapping fixes', async () => {
  const files = new Map([[ordersFile, 'one();\ntwo();\nthree();\nfour();']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  publish(editor.vscode, editor.collection, root, 'backend-perf-check', [
    fixed(1, 'one();', 'ONE();'),
    fixed(2, 'two();\nthree();', 'TWO_THREE();'),
    fixed(3, 'three();', 'THREE();'),
    fixed(4, 'gone();', 'GONE();'),
  ]);
  const disposables = registerQuickFixes(editor.vscode, { diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [] });
  const provider = disposables.at(-1);
  const lineActions = provider.provideCodeActions({ uri: ordersFile }, new Range(0, 0, 0, 0), {});
  const applyAll = lineActions.find((action) => action.title === 'Apply all Backend Checkers fixes in this file');
  await editor.commands.get(applyAll.command.command)(...applyAll.command.arguments);
  assert.equal(editor.appliedEdits.length, 1, 'one edit means one undo');
  assert.deepEqual(
    editor.appliedEdits[0].operations.map(({ line, text }) => [line, text]),
    [
      [0, 'ONE();'],
      [1, 'TWO_THREE();'],
    ],
  );
  assert.deepEqual(editor.messages, [
    ['warning', 'Backend Checkers applied 2 fix(es); skipped 2 stale, overlapping or existing-file fix(es).'],
  ]);

  const [fixAll] = await provider.provideCodeActions({ uri: ordersFile }, new Range(0, 0, 0, 0), {
    only: editor.vscode.CodeActionKind.SourceFixAll,
  });
  assert.equal(fixAll.kind.value, 'source.fixAll.backendCheckers');
  assert.equal(fixAll.edit.operations.length, 2, 'the fix-all action carries its edit for code actions on save');
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
    before: files.get(ordersFile),
    after: '// indexed\n' + files.get(ordersFile),
  };
  publish(editor.vscode, editor.collection, root, 'backend-perf-check', [
    { ...finding(1), fix: { changes: [create, replace], note: 'Adds the missing index.' } },
  ]);
  const provider = registerQuickFixes(editor.vscode, { diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [] }).at(-1);
  const [apply] = provider.provideCodeActions({ uri: ordersFile }, new Range(0, 0, 0, 0), {});
  assert.equal(apply.title, 'Apply fix: array-repeated-membership');
  await editor.commands.get(apply.command.command)(...apply.command.arguments);
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
  await editor.commands.get(apply.command.command)(...apply.command.arguments);
  assert.deepEqual(
    editor.appliedEdits[1].operations.map(({ type }) => type),
    ['replace'],
    'a file that already has this content is kept and the rest of the fix still applies',
  );

  files.set(migration, '-- written by hand');
  await editor.commands.get(apply.command.command)(...apply.command.arguments);
  assert.equal(editor.appliedEdits.length, 2, 'a file with other content blocks the whole fix');
  assert.match(editor.messages.at(-1)[1], /001_orders_index\.sql already exists/);
});

test('a live-database finding without a file shows on package.json with its table and fix', () => {
  const packageFile = path.join(root, 'package.json');
  const editor = fakeEditor(new Map([[packageFile, '{\n  "name": "example"\n}']]));
  editor.open(packageFile);
  const migration = { file: 'migrations/002.sql', line: 1, before: '', after: 'CREATE INDEX ...;\n', create: true };
  publish(editor.vscode, editor.collection, root, 'backend-perf-check', [
    {
      ruleId: 'db-missing-fk-index',
      target: 'public.orders',
      message: 'Foreign key has no index.',
      fix: { changes: [migration] },
    },
  ]);
  const [diagnostic] = editor.byUri.get(packageFile);
  assert.deepEqual(diagnostic.range.start, { line: 0, character: 0 });
  assert.equal(
    diagnostic.message,
    'Code: (new file migrations/002.sql) → CREATE INDEX ...;\npublic.orders: Foreign key has no index.',
  );
  const provider = registerQuickFixes(editor.vscode, { diagnosticsFor: (uri) => editor.byUri.get(uri) ?? [] }).at(-1);
  const [apply, dismiss] = provider.provideCodeActions({ uri: packageFile }, new Range(0, 0, 0, 0), {});
  assert.equal(apply.title, 'Apply fix: db-missing-fk-index');
  assert.equal(dismiss.command.arguments[0].lineText, 'public.orders', 'dismissed by table, not by package.json text');
});

test('code lenses put Apply fix and Dismiss buttons on fixable lines and an apply-all button at the top', () => {
  const { registerCodeLenses } = require('../diagnostics.cjs');
  const files = new Map([[ordersFile, 'one();\ntwo();\nthree();']]);
  const editor = fakeEditor(files);
  editor.open(ordersFile);
  let provider;
  editor.vscode.EventEmitter = class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  };
  editor.vscode.CodeLens = class {
    constructor(range, command) {
      Object.assign(this, { range, command });
    }
  };
  editor.vscode.languages.registerCodeLensProvider = (_selector, registered) => (provider = registered);
  editor.vscode.workspace.getConfiguration = () => ({ get: (_key, fallback) => fallback });
  publish(editor.vscode, editor.collection, root, 'backend-perf-check', [
    fixed(1, 'one();', 'ONE();'),
    finding(2),
    fixed(3, 'three();', 'THREE();'),
  ]);
  registerCodeLenses(editor.vscode, (uri) => editor.byUri.get(uri) ?? []);
  const lenses = provider.provideCodeLenses({ uri: ordersFile });
  assert.deepEqual(
    lenses.map((lens) => [lens.range.start.line, lens.command.title]),
    [
      [0, '$(wrench) Apply all 2 Backend Checkers fixes in this file'],
      [0, '$(wrench) Apply fix: array-repeated-membership'],
      [0, 'Dismiss'],
      [2, '$(wrench) Apply fix: array-repeated-membership'],
      [2, 'Dismiss'],
    ],
  );
  editor.vscode.workspace.getConfiguration = () => ({ get: () => false });
  assert.deepEqual(provider.provideCodeLenses({ uri: ordersFile }), [], 'the codeLens setting turns them off');
});
