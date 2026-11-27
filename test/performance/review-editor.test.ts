import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Memento } from '../../editor/types/dismissal.cjs';
import type { EditorDisposable } from '../../editor/types/vscode-api.cjs';
import type { ModuleLoadHook } from '../types/module-internals.js';
import type * as Extension from '../../editor/extension.cjs';
import { watchEditor } from '../../lib/performance/editor-watch.js';

const requireFromHere = createRequire(import.meta.url);

const workspaceState: Memento = { get: (_key, fallback) => fallback, update: async () => {} };

interface FakeConfiguration {
  get(key: string, fallback: unknown): unknown;
}

interface FakeOutputChannel {
  appendLine(line: string): void;
  show(): void;
  dispose(): void;
}

type ConfigurationHandler = (change: { affectsConfiguration(section: string): boolean }) => void;
type CommandHandler = () => Promise<void> | void;

// Only the members the tests replace are named; the rest of the fake is whatever the extension
// reads.
interface FakeVscode {
  workspace: {
    getConfiguration(): FakeConfiguration;
    onDidChangeConfiguration(handler: ConfigurationHandler): EditorDisposable;
    [member: string]: unknown;
  };
  window: {
    createOutputChannel(): FakeOutputChannel;
    [member: string]: unknown;
  };
  [member: string]: unknown;
}

function isModuleLoadHook(candidate: unknown): candidate is ModuleLoadHook {
  return typeof candidate === 'function' && '_load' in candidate && typeof candidate._load === 'function';
}

function patchableModule(): ModuleLoadHook {
  if (!isModuleLoadHook(Module)) throw new Error('node:module no longer exposes the _load hook');
  return Module;
}

function createVscode(root: string): { vscode: FakeVscode; commands: Map<string, CommandHandler> } {
  const folder = { uri: { scheme: 'file', fsPath: root, toString: () => 'file:' + root }, name: 'ws' };
  const noop = () => ({ dispose() {} });
  const commands = new Map<string, CommandHandler>();
  const vscode: FakeVscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    RelativePattern: class {},
    StatusBarAlignment: { Left: 1 },
    CodeActionKind: { QuickFix: { append: () => ({}) }, SourceFixAll: { append: () => ({}) } },
    Disposable: {
      from: (...items: EditorDisposable[]) => ({ dispose: () => items.forEach((item) => item.dispose()) }),
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [folder],
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => (key === 'cli' ? 'relative.cjs' : fallback),
      }),
      findFiles: async () => [],
      createFileSystemWatcher: () => ({ onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} }),
      getWorkspaceFolder: () => folder,
      onDidOpenTextDocument: noop,
      onDidSaveTextDocument: noop,
      onDidRenameFiles: noop,
      onDidDeleteFiles: noop,
      onDidChangeWorkspaceFolders: noop,
      onDidChangeConfiguration: noop,
      textDocuments: [],
    },
    languages: {
      createDiagnosticCollection: () => ({ clear() {}, dispose() {}, get() {}, set() {}, forEach() {} }),
      registerHoverProvider: noop,
      registerCodeLensProvider: noop,
      registerCodeActionsProvider: noop,
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    },
    commands: {
      registerCommand: (name: string, handler: CommandHandler) => (commands.set(name, handler), { dispose() {} }),
    },
  };
  return { vscode, commands };
}

test('the extension scan probes config files without blocking synchronous filesystem calls', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-editor-'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  const { vscode, commands } = createVscode(root);
  const moduleHooks = patchableModule();
  const originalLoad = moduleHooks._load;
  moduleHooks._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
  };
  const originalExists = fs.existsSync;
  const probes: string[] = [];
  fs.existsSync = (file: fs.PathLike) => (probes.push(String(file)), originalExists(file));
  context.after(() => {
    moduleHooks._load = originalLoad;
    fs.existsSync = originalExists;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const extension: typeof Extension = requireFromHere('../../editor/extension.cjs');
  const subscriptions: EditorDisposable[] = [];
  extension.activate({ extensionPath: root, subscriptions, workspaceState });
  const scan = commands.get('loadwise.scan');
  assert.ok(scan);
  await scan();
  for (const subscription of subscriptions) subscription.dispose();
  assert.deepEqual(
    probes.filter((file) => file.startsWith(root)),
    [],
  );
});

const hangingChecker = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "fs.appendFileSync(path.join(__dirname, 'starts.log'), process.pid + '\\n');",
  "const release = path.join(__dirname, 'release');",
  'const poll = setInterval(() => {',
  '  if (fs.existsSync(release)) { clearInterval(poll); console.log(\'{"findings":[]}\'); }',
  '}, 10);',
  '// A watch-mode checker keeps running after its report, as loadwise perf --watch does.',
  "if (process.argv.includes('--watch')) setInterval(() => {}, 60000);",
].join('\n');

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function startedPids(logFile: string): number[] {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('changes during a running scan abort the stale child and coalesce into one debounced follow-up', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-editor-burst-'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  const script = path.join(root, 'checker.cjs');
  fs.writeFileSync(script, hangingChecker);
  const logFile = path.join(root, 'starts.log');
  const { vscode } = createVscode(root);
  let configurationChanged: ConfigurationHandler | undefined;
  vscode.workspace.getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key === 'cli' ? script : fallback),
  });
  vscode.workspace.onDidChangeConfiguration = (handler: ConfigurationHandler) => (
    (configurationChanged = handler),
    { dispose() {} }
  );
  const lines: string[] = [];
  vscode.window.createOutputChannel = () => ({
    appendLine: (line: string) => lines.push(line),
    show() {},
    dispose() {},
  });
  const moduleHooks = patchableModule();
  const originalLoad = moduleHooks._load;
  moduleHooks._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
  };
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const subscriptions: EditorDisposable[] = [];
  context.after(() => {
    moduleHooks._load = originalLoad;
    for (const subscription of subscriptions) subscription.dispose();
    // Windows keeps the folder locked while the killed watch child exits.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  delete requireFromHere.cache[requireFromHere.resolve('../../editor/extension.cjs')];
  const extension: typeof Extension = requireFromHere('../../editor/extension.cjs');
  extension.activate({
    extensionPath: root,
    subscriptions,
    workspaceState,
  });
  const change = () => {
    assert.ok(configurationChanged);
    configurationChanged({ affectsConfiguration: () => true });
  };

  context.mock.timers.tick(650);
  // The performance checker runs as a long-lived watch child beside the one-shot maintainability
  // scan.
  await waitFor(() => startedPids(logFile).length === 2);
  const stalePids = startedPids(logFile);

  for (let index = 0; index < 5; index++) {
    change();
    context.mock.timers.tick(300);
  }
  await waitFor(() => !stalePids.some(isAlive));
  assert.equal(startedPids(logFile).length, 2, 'no immediate re-run while changes keep arriving');

  context.mock.timers.tick(349);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startedPids(logFile).length, 2, 'follow-up waits the full debounce after the last change');
  context.mock.timers.tick(1);
  await waitFor(() => startedPids(logFile).length === 4);

  fs.writeFileSync(path.join(root, 'release'), '');
  const published = () => lines.filter((line) => line.includes('finding(s)'));
  await waitFor(() => published().some((line) => line.includes('loadwise maint — 0 finding(s)')));
  await waitFor(() => published().some((line) => line.includes('loadwise perf — 0 finding(s)')));
  assert.equal(startedPids(logFile).length, 4, 'exactly one follow-up scan (a fresh watcher and maintainability)');
  assert.equal(published().length, 2, 'only the newest scan published');
});

test('editor watch aborts the stale scan child on change and runs one follow-up after the last change', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-watch-burst-'));
  const maintainabilityCli = path.join(root, 'checker.cjs');
  fs.writeFileSync(maintainabilityCli, hangingChecker);
  const logFile = path.join(root, 'starts.log');
  const watcher = Object.assign(new EventEmitter(), { close: async () => {} });
  let refresh: (() => void) | undefined;
  const originalSend = process.send;
  const originalDisconnect = process.disconnect;
  const originalWorker = process.env.LOADWISE_EDITOR_WORKER;
  const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected');
  process.send = () => true;
  process.disconnect = () => {};
  process.env.LOADWISE_EDITOR_WORKER = '1';
  Object.defineProperty(process, 'connected', { value: true, configurable: true, writable: true });
  const logged: string[] = [];
  context.mock.method(console, 'log', (line: string) => logged.push(line));
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.after(() => {
    process.emit('SIGINT');
    process.send = originalSend;
    process.disconnect = originalDisconnect;
    if (originalWorker === undefined) delete process.env.LOADWISE_EDITOR_WORKER;
    else process.env.LOADWISE_EDITOR_WORKER = originalWorker;
    if (originalConnected) Object.defineProperty(process, 'connected', originalConnected);
    else Reflect.deleteProperty(process, 'connected');
    fs.rmSync(root, { recursive: true, force: true });
  });
  let checkCodeCalls = 0;
  watchEditor(root, undefined, async () => (checkCodeCalls++, []), maintainabilityCli, {
    watchTree: () => watcher,
    listenForEditorRefresh: (_root, callback) => ((refresh = callback), { close() {} }),
  });

  watcher.emit('all', 'add', 'a.js');
  watcher.emit('ready');
  context.mock.timers.tick(500);
  await waitFor(() => startedPids(logFile).length === 1);
  const [stalePid] = startedPids(logFile);

  for (let index = 0; index < 5; index++) {
    watcher.emit('all', 'change', 'a.js');
    context.mock.timers.tick(200);
  }
  assert.ok(refresh);
  refresh();
  await waitFor(() => !isAlive(stalePid));
  await waitFor(() => logged.filter((line) => line === 'Loadwise: scan finished').length === 1);
  assert.equal(checkCodeCalls, 1, 'no immediate re-run while changes keep arriving');

  context.mock.timers.tick(499);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkCodeCalls, 1, 'follow-up waits the full debounce after the last change');
  context.mock.timers.tick(1);
  await waitFor(() => startedPids(logFile).length === 2);
  assert.equal(checkCodeCalls, 2);

  fs.writeFileSync(path.join(root, 'release'), '');
  await waitFor(() => logged.filter((line) => line === 'Loadwise: scan finished').length === 2);
  assert.equal(startedPids(logFile).length, 2, 'exactly one follow-up scan');
  assert.equal(checkCodeCalls, 2);
});
