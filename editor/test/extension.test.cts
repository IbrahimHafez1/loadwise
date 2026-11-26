import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Memento } from '../types/dismissal.cjs';
import type { FakeDiagnostic, FakePosition, FakeRange } from '../../test/types/fake-vscode.cjs';
import type * as Extension from '../extension.cjs';

const finding = { file: 'a.ts', line: 1, column: 1, ruleId: 'sync-io', message: 'Blocking call.' };
// Watch mode reports once, then reports no findings after the clear flag appears, like an
// incremental rebuild.
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

interface FakeKind {
  value: string;
  append(part: string): FakeKind;
  intersects(): boolean;
}

function kind(value: string): FakeKind {
  return { value, append: (part: string) => kind(value + '.' + part), intersects: () => false };
}

type Handler = (...args: unknown[]) => unknown;

interface FakeStatusItem {
  text?: string;
  show(): void;
  dispose(): void;
}

interface FakeUri {
  fsPath: string;
  scheme: string;
  toString(): string;
}

interface FakeCollection {
  byUri: Map<string, FakeDiagnostic[]>;
  get(uri: FakeUri): FakeDiagnostic[] | undefined;
  forEach(visit: (uri: FakeUri, diagnostics: FakeDiagnostic[]) => void): void;
  set(entries: [FakeUri, FakeDiagnostic[] | undefined][]): void;
  clear(): void;
  dispose(): void;
}

/** The Module internals the test patches so the extension's `require('vscode')` gets the fake. */
interface ModuleLoader {
  _load(this: unknown, request: string, ...rest: unknown[]): unknown;
}

function hasModuleLoader(candidate: typeof Module): candidate is typeof Module & ModuleLoader {
  return typeof Reflect.get(candidate, '_load') === 'function';
}

function fakeVscode(root: string, settings: Record<string, string>) {
  const output: string[] = [];
  const collections: FakeCollection[] = [];
  const commands = new Map<string, Handler>();
  const watchers = new Map<string, Handler>();
  const statusItem: FakeStatusItem = { show() {}, dispose() {} };
  const disposable = () => ({ dispose() {} });
  const uriOf = (fsPath: string): FakeUri => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const folder = { uri: uriOf(root), name: 'example' };
  const vscode = {
    Uri: { file: uriOf },
    Range: class implements FakeRange {
      declare start: FakePosition;
      declare end: FakePosition;
      constructor(line: number, character: number, endLine: number, endCharacter: number) {
        this.start = { line, character };
        this.end = { line: endLine, character: endCharacter };
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
      createOutputChannel: () => ({ appendLine: (line: string) => output.push(line), show() {}, dispose() {} }),
      createStatusBarItem: () => statusItem,
    },
    commands: {
      registerCommand(name: string, handler: Handler) {
        commands.set(name, handler);
        return disposable();
      },
    },
    languages: {
      registerHoverProvider: disposable,
      registerCodeLensProvider: disposable,
      registerCodeActionsProvider: disposable,
      createDiagnosticCollection() {
        const byUri = new Map<string, FakeDiagnostic[]>();
        const collection: FakeCollection = {
          byUri,
          get: (uri: FakeUri) => byUri.get(uri.toString()),
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
      getConfiguration: () => ({ get: (key: string, fallback: string) => settings[key] ?? fallback }),
      getWorkspaceFolder: () => folder,
      findFiles: async () => [],
      createFileSystemWatcher: (glob: string) => ({
        onDidCreate: disposable,
        onDidChange(handler: Handler) {
          watchers.set(glob, handler);
          return disposable();
        },
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
  const diagnosticsIn = (file: string) => collections.flatMap((collection) => collection.byUri.get(file) ?? []);
  return { vscode, output, statusItem, diagnosticsIn, commands, watchers };
}

async function until(predicate: () => unknown, what: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function startExtension(performanceCliSource: string) {
  if (!hasModuleLoader(Module)) throw new Error('Module._load is unavailable');
  const moduleLoader = Module;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-checkers-extension-'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'a.ts'), 'readFileSync(name);\n');
  const performanceCli = path.join(root, 'perf-cli.cjs');
  const maintainabilityCli = path.join(root, 'maintainability-cli.cjs');
  fs.writeFileSync(performanceCli, performanceCliSource);
  fs.writeFileSync(maintainabilityCli, emptyCli);
  // Stands in for bin/loadwise.js: the first argument picks the checker.
  const cli = path.join(root, 'cli.cjs');
  fs.writeFileSync(cli, "require(process.argv[2] === 'maint' ? './maintainability-cli.cjs' : './perf-cli.cjs');");
  const editor = fakeVscode(root, { cli });
  const load = moduleLoader._load;
  moduleLoader._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'vscode' ? editor.vscode : load.call(this, request, ...rest);
  };
  const extensionPath = require.resolve('../extension.cjs');
  delete require.cache[extensionPath];
  try {
    const workspaceState: Memento = {
      get: <Value,>(_key: string, fallback: Value) => fallback,
      update: async () => {},
    };
    const subscriptions: { dispose(): void }[] = [];
    const context = { subscriptions, extensionPath: root, workspaceState };
    const { activate }: typeof Extension = require(extensionPath);
    activate(context);
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
    moduleLoader._load = load;
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
    assert.match(String(extension.statusItem.text), /^\$\(checklist\) 0 findings/);
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

test('manual refresh and project rule changes each rerun the performance watcher', async () => {
  const extension = startExtension(`
const fs = require('node:fs');
console.log(JSON.stringify({ findings: fs.existsSync('loadwise.config.json') ? [] : [${JSON.stringify(finding)}] }));
if (process.argv.includes('--watch')) setInterval(() => {}, 1000);
`);
  try {
    await until(() => extension.diagnosticsIn(extension.file).length === 1, 'initial finding');
    const config = path.join(extension.root, 'loadwise.config.json');
    fs.writeFileSync(config, '{}');
    const scanCommand = extension.commands.get('loadwise.scan');
    assert.ok(scanCommand);
    await scanCommand();
    await until(() => extension.diagnosticsIn(extension.file).length === 0, 'manual refresh');
    fs.unlinkSync(config);
    const configWatcher = [...extension.watchers].find(([glob]) => glob.includes('loadwise.config.json'));
    assert.ok(configWatcher, 'the extension watches the unified config');
    configWatcher[1](extension.vscode.Uri.file(config));
    await until(() => extension.diagnosticsIn(extension.file).length === 1, 'config change refresh');
  } finally {
    extension.stop();
  }
});
