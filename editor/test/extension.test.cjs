'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const finding = { file: 'a.ts', line: 1, column: 1, ruleId: 'sync-io', message: 'Blocking call.' };
// Watch mode reports once, then reports no findings after the clear flag appears, like an incremental rebuild.
const watchingCli = `
const fs = require('node:fs');
const finding = ${JSON.stringify(finding)};
if (process.argv.includes('--watch')) {
  console.log(JSON.stringify({ findings: [finding] }));
  const timer = setInterval(() => {
    if (!fs.existsSync('clear.flag')) return;
    clearInterval(timer);
    console.log(JSON.stringify({ findings: [] }));
    setInterval(() => {}, 1000);
  }, 50);
} else console.log(JSON.stringify({ findings: [finding] }));
`;
const crashingWatchCli = `
if (process.argv.includes('--watch')) process.exit(3);
console.log(JSON.stringify({ findings: [${JSON.stringify(finding)}] }));
`;
const emptyCli = `console.log(JSON.stringify({ findings: [] }));`;

function kind(value) {
  return { value, append: (part) => kind(value + '.' + part), intersects: () => false };
}

function fakeVscode(root, settings) {
  const output = [];
  const collections = [];
  const statusItem = { show() {}, dispose() {} };
  const disposable = () => ({ dispose() {} });
  const uriOf = (fsPath) => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const folder = { uri: uriOf(root), name: 'example' };
  const vscode = {
    Uri: { file: uriOf },
    Range: class {
      constructor(line, character, endLine, endCharacter) {
        this.start = { line, character };
        this.end = { line: endLine, character: endCharacter };
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
    CodeActionKind: { QuickFix: kind('quickfix'), SourceFixAll: kind('source.fixAll') },
    StatusBarAlignment: { Left: 1 },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    RelativePattern: class {},
    Disposable: { from: disposable },
    window: {
      createOutputChannel: () => ({ appendLine: (line) => output.push(line), show() {}, dispose() {} }),
      createStatusBarItem: () => statusItem,
    },
    commands: { registerCommand: disposable },
    languages: {
      registerHoverProvider: disposable,
      registerCodeLensProvider: disposable,
      registerCodeActionsProvider: disposable,
      createDiagnosticCollection() {
        const byUri = new Map();
        const collection = {
          byUri,
          get: (uri) => byUri.get(uri.toString()),
          forEach: (visit) => byUri.forEach((list, key) => visit(uriOf(key), list)),
          set(entries) {
            for (const [uri, list] of entries) {
              if (list) byUri.set(uri.toString(), list);
              else byUri.delete(uri.toString());
            }
          },
          clear: () => byUri.clear(),
          dispose() {},
        };
        collections.push(collection);
        return collection;
      },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [folder],
      textDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
      getWorkspaceFolder: () => folder,
      findFiles: async () => [],
      createFileSystemWatcher: () => ({
        onDidCreate: disposable,
        onDidChange: disposable,
        onDidDelete: disposable,
        dispose() {},
      }),
      onDidOpenTextDocument: disposable,
      onDidSaveTextDocument: disposable,
      onDidRenameFiles: disposable,
      onDidDeleteFiles: disposable,
      onDidChangeWorkspaceFolders: disposable,
      onDidChangeConfiguration: disposable,
    },
  };
  const diagnosticsIn = (file) => collections.flatMap((collection) => collection.byUri.get(file) ?? []);
  return { vscode, output, statusItem, diagnosticsIn };
}

async function until(predicate, what) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function startExtension(performanceCliSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-checkers-extension-'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'a.ts'), 'readFileSync(name);\n');
  const performanceCli = path.join(root, 'perf-cli.cjs');
  const maintainabilityCli = path.join(root, 'maintainability-cli.cjs');
  fs.writeFileSync(performanceCli, performanceCliSource);
  fs.writeFileSync(maintainabilityCli, emptyCli);
  // Stands in for bin/loadwise.cjs: the first argument picks the checker.
  const cli = path.join(root, 'cli.cjs');
  fs.writeFileSync(cli, "require(process.argv[2] === 'maint' ? './maintainability-cli.cjs' : './perf-cli.cjs');");
  const editor = fakeVscode(root, { cli });
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? editor.vscode : load.call(this, request, ...rest);
  };
  const extensionPath = require.resolve('../extension.cjs');
  delete require.cache[extensionPath];
  try {
    const context = { subscriptions: [], extensionPath: root, workspaceState: { get: (_key, fallback) => fallback } };
    require(extensionPath).activate(context);
    return {
      ...editor,
      root,
      file: path.join(root, 'a.ts'),
      stop() {
        for (const item of context.subscriptions) item.dispose();
        // Windows keeps the folder locked while the killed watcher exits.
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      },
    };
  } finally {
    Module._load = load;
  }
}

test('watch-mode reports update diagnostics and the status bar, and clear files without findings', async () => {
  const extension = startExtension(watchingCli);
  try {
    await until(() => extension.diagnosticsIn(extension.file).length === 1, 'the first watch report');
    await until(() => extension.statusItem.text?.startsWith('$(checklist) 1 finding · '), 'the status bar count');
    assert.ok(extension.output.some((line) => line.includes('watching tsconfig.json incrementally')));
    fs.writeFileSync(path.join(extension.root, 'clear.flag'), '');
    await until(() => extension.diagnosticsIn(extension.file).length === 0, 'the incremental report to clear');
    assert.match(extension.statusItem.text, /^\$\(checklist\) 0 findings/);
  } finally {
    extension.stop();
  }
});

test('when watch mode exits, full rescans take over', async () => {
  const extension = startExtension(crashingWatchCli);
  try {
    await until(() => extension.diagnosticsIn(extension.file).length === 1, 'the fallback scan');
    assert.ok(extension.output.some((line) => line.includes('Falling back to full rescans')));
  } finally {
    extension.stop();
  }
});
