'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workspaceState = { get: (_key, fallback) => fallback, update: async () => {} };

function createVscode(root) {
  const folder = { uri: { scheme: 'file', fsPath: root, toString: () => 'file:' + root }, name: 'ws' };
  const noop = () => ({ dispose() {} });
  const commands = new Map();
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    RelativePattern: class {},
    StatusBarAlignment: { Left: 1 },
    CodeActionKind: { QuickFix: { append: () => ({}) }, SourceFixAll: { append: () => ({}) } },
    Disposable: { from: (...items) => ({ dispose: () => items.forEach((item) => item.dispose?.()) }) },
    workspace: {
      isTrusted: true,
      workspaceFolders: [folder],
      getConfiguration: () => ({ get: (_key, fallback) => (_key === 'performanceCli' ? 'relative.cjs' : fallback) }),
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
    commands: { registerCommand: (name, handler) => (commands.set(name, handler), { dispose() {} }) },
  };
  return { vscode, commands };
}

test('the extension scan probes config files without blocking synchronous filesystem calls', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-editor-'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  const { vscode, commands } = createVscode(root);
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
  };
  const originalExists = fs.existsSync;
  const probes = [];
  fs.existsSync = (file) => (probes.push(String(file)), originalExists(file));
  context.after(() => {
    Module._load = originalLoad;
    fs.existsSync = originalExists;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const extension = require('../editor/extension.cjs');
  const subscriptions = [];
  extension.activate({ extensionPath: root, subscriptions, workspaceState });
  await commands.get('backendCheckers.scan')();
  for (const subscription of subscriptions) subscription.dispose?.();
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
  '// A watch-mode checker keeps running after its report, as backend-perf-check --watch does.',
  "if (process.argv.includes('--watch')) setInterval(() => {}, 60000);",
].join('\n');

async function waitFor(condition) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function startedPids(logFile) {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}

function isAlive(pid) {
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
  let configurationChanged;
  vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => (key.endsWith('Cli') ? script : fallback) });
  vscode.workspace.onDidChangeConfiguration = (handler) => ((configurationChanged = handler), { dispose() {} });
  const lines = [];
  vscode.window.createOutputChannel = () => ({ appendLine: (line) => lines.push(line), show() {}, dispose() {} });
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
  };
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const subscriptions = [];
  context.after(() => {
    Module._load = originalLoad;
    for (const subscription of subscriptions) subscription.dispose?.();
    // Windows keeps the folder locked while the killed watch child exits.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  delete require.cache[require.resolve('../editor/extension.cjs')];
  require('../editor/extension.cjs').activate({ extensionPath: root, subscriptions, workspaceState });
  const change = () => configurationChanged({ affectsConfiguration: () => true });

  context.mock.timers.tick(650);
  // The performance checker runs as a long-lived watch child beside the one-shot maintainability scan.
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
  await waitFor(() => published().some((line) => line.includes('maintainability-check — 0 finding(s)')));
  await waitFor(() => published().some((line) => line.includes('backend-perf-check — 0 finding(s)')));
  assert.equal(startedPids(logFile).length, 4, 'exactly one follow-up scan (a fresh watcher and maintainability)');
  assert.equal(published().length, 2, 'only the newest scan published');
});

test('editor watch aborts the stale scan child on change and runs one follow-up after the last change', async (context) => {
  const { EventEmitter } = require('node:events');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-watch-burst-'));
  const packageDirectory = path.join(root, 'node_modules', 'maintainability-check');
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), '{"name":"maintainability-check","version":"1.0.0"}');
  fs.writeFileSync(path.join(packageDirectory, 'bin', 'maintainability-check.cjs'), hangingChecker);
  const logFile = path.join(packageDirectory, 'bin', 'starts.log');
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  let refresh;
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'chokidar') return { watch: () => watcher };
    if (request === './editor-signal.cjs') {
      return { listenForEditorRefresh: (_root, callback) => ((refresh = callback), { close() {} }) };
    }
    return originalLoad.call(this, request, ...rest);
  };
  const originalSend = process.send;
  const originalDisconnect = process.disconnect;
  const originalWorker = process.env.BACKEND_CHECKERS_EDITOR_WORKER;
  const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected');
  process.send = () => {};
  process.disconnect = () => {};
  process.env.BACKEND_CHECKERS_EDITOR_WORKER = '1';
  Object.defineProperty(process, 'connected', { value: true, configurable: true, writable: true });
  const logged = [];
  context.mock.method(console, 'log', (line) => logged.push(line));
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.after(() => {
    process.emit('SIGINT');
    Module._load = originalLoad;
    process.send = originalSend;
    process.disconnect = originalDisconnect;
    if (originalWorker === undefined) delete process.env.BACKEND_CHECKERS_EDITOR_WORKER;
    else process.env.BACKEND_CHECKERS_EDITOR_WORKER = originalWorker;
    if (originalConnected) Object.defineProperty(process, 'connected', originalConnected);
    else delete process.connected;
    fs.rmSync(root, { recursive: true, force: true });
  });
  let checkCodeCalls = 0;
  const modulePath = require.resolve('../lib/editor-watch.cjs');
  delete require.cache[modulePath];
  require(modulePath).watchEditor(root, undefined, async () => (checkCodeCalls++, []));

  watcher.emit('all', 'add', 'a.js');
  watcher.emit('ready');
  context.mock.timers.tick(500);
  await waitFor(() => startedPids(logFile).length === 1);
  const [stalePid] = startedPids(logFile);

  for (let index = 0; index < 5; index++) {
    watcher.emit('all', 'change', 'a.js');
    context.mock.timers.tick(200);
  }
  refresh();
  await waitFor(() => !isAlive(stalePid));
  await waitFor(() => logged.filter((line) => line === 'Backend Checkers: scan finished').length === 1);
  assert.equal(checkCodeCalls, 1, 'no immediate re-run while changes keep arriving');

  context.mock.timers.tick(499);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkCodeCalls, 1, 'follow-up waits the full debounce after the last change');
  context.mock.timers.tick(1);
  await waitFor(() => startedPids(logFile).length === 2);
  assert.equal(checkCodeCalls, 2);

  fs.writeFileSync(path.join(packageDirectory, 'bin', 'release'), '');
  await waitFor(() => logged.filter((line) => line === 'Backend Checkers: scan finished').length === 2);
  assert.equal(startedPids(logFile).length, 2, 'exactly one follow-up scan');
  assert.equal(checkCodeCalls, 2);
});
