'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { publish, refreshDocument, registerExamples } = require('./diagnostics.cjs');

const run = promisify(execFile);
const debounceMs = 650;
const maxReportBytes = 64 * 1024 * 1024;
const perf = 'backend-perf-check';
const maint = 'maintainability-check';
const polyglotGlob = '**/*.{py,go,java,cs,rs}';
const sourceSuffixes = new Set(
  'js jsx ts tsx mjs mts cjs cts py go java cs rs rb php kt kts c h cc cpp cxx hpp hh hxx'.split(' '),
);
const sourceGlob = '**/*.{' + [...sourceSuffixes].join(',') + '}';
const ignored = new Set(
  '.git node_modules dist build coverage .next .nuxt .venv venv __pycache__ target vendor'.split(' '),
);
const excludeGlob = '**/{' + [...ignored].join(',') + '}/**';

async function readFindings(script, args, cwd, signal) {
  const options = {
    cwd,
    signal,
    windowsHide: true,
    maxBuffer: maxReportBytes,
    encoding: 'utf8',
    env: { ...process.env, BACKEND_CHECKERS_EDITOR_SCAN: '1' },
  };
  let stdout;
  try {
    ({ stdout } = await run('node', [script, ...args, '--json'], options));
  } catch (error) {
    if (error.code !== 1) throw new Error(error.stderr?.trim() || error.message, { cause: error });
    stdout = error.stdout;
  }
  const report = JSON.parse(stdout);
  if (!Array.isArray(report.findings)) throw new Error('Checker returned an invalid findings report.');
  return report.findings;
}

function monitor(folder, extensionPath, output) {
  const root = folder.uri.fsPath;
  const signal = new AbortController();
  const collections = new Map();
  let revision = 0;
  let running;
  let timer;

  function collection(id) {
    if (!collections.has(id)) collections.set(id, vscode.languages.createDiagnosticCollection(id));
    return collections.get(id);
  }
  function findOne(glob) {
    return vscode.workspace
      .findFiles(new vscode.RelativePattern(folder, glob), excludeGlob, 1)
      .then((files) => files.length > 0);
  }
  async function scan(version) {
    const settings = vscode.workspace.getConfiguration('backendCheckers', folder.uri);
    if (!settings.get('enabled', true) || !vscode.workspace.isTrusted) {
      for (const diagnostics of collections.values()) diagnostics.clear();
      return;
    }
    const explicitProject = settings.get('project', '');
    const project =
      explicitProject || ['tsconfig.json', 'jsconfig.json'].find((name) => fs.existsSync(path.join(root, name)));
    const hasMaintainabilityInput =
      project || fs.existsSync(path.join(root, 'maintainability.config.json')) || (await findOne(sourceGlob));
    const hasPolyglotInput = await findOne(polyglotGlob);
    const tasks = [
      { id: perf, source: perf, args: project ? ['-p', project] : null },
      { id: maint, source: maint, args: hasMaintainabilityInput ? ['.'] : null },
      { id: perf + '-polyglot', source: perf, args: hasPolyglotInput ? ['polyglot', '.'] : null },
    ];
    for (const { id, source, args } of tasks) {
      if (signal.signal.aborted || version !== revision) return;
      const diagnostics = collection(id);
      if (!args) {
        diagnostics.clear();
        continue;
      }
      const override = settings.get(source === perf ? 'performanceCli' : 'maintainabilityCli', '');
      const script = override || path.join(extensionPath, 'tools', source, 'bin', source + '.cjs');
      try {
        if (!path.isAbsolute(script)) throw new Error('CLI override must be an absolute path.');
        const findings = await readFindings(script, args, root, signal.signal);
        if (version !== revision || signal.signal.aborted) return;
        publish(vscode, diagnostics, root, source, findings);
        output.appendLine(folder.name + ' / ' + id + ' — ' + findings.length + ' finding(s)');
      } catch (error) {
        if (signal.signal.aborted || version !== revision) return;
        diagnostics.clear();
        output.appendLine(folder.name + ' / ' + id + ' — ' + error.message);
      }
    }
  }
  function start() {
    clearTimeout(timer);
    if (!running) {
      running = (async () => {
        let version;
        do {
          version = revision;
          try {
            await scan(version);
          } catch (error) {
            if (!signal.signal.aborted) output.appendLine(folder.name + ' — ' + error.message);
          }
        } while (!signal.signal.aborted && version !== revision);
      })().finally(() => {
        running = undefined;
      });
    }
    return running;
  }
  function schedule() {
    revision++;
    clearTimeout(timer);
    if (!running) timer = setTimeout(start, debounceMs);
  }
  return {
    schedule,
    *diagnosticsFor(uri) {
      for (const diagnostics of collections.values()) yield* diagnostics.get(uri) ?? [];
    },
    open(document) {
      for (const diagnostics of collections.values()) refreshDocument(vscode, diagnostics, document);
    },
    scanNow() {
      revision++;
      return start();
    },
    dispose() {
      clearTimeout(timer);
      signal.abort();
      for (const diagnostics of collections.values()) diagnostics.dispose();
    },
  };
}

function activate(context) {
  const folders = new Map();
  const output = vscode.window.createOutputChannel('Backend Checkers');
  function add(folder) {
    if (folder.uri.scheme !== 'file') return;
    const session = monitor(folder, context.extensionPath, output);
    folders.set(folder.uri.toString(), session);
    session.schedule();
  }
  function changed(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || uri.scheme !== 'file') return;
    const segments = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep);
    if (segments.some((segment) => ignored.has(segment))) return;
    folders.get(folder.uri.toString())?.schedule();
  }
  const watcher = vscode.workspace.createFileSystemWatcher(sourceGlob);
  context.subscriptions.push(
    output,
    watcher,
    registerExamples(vscode, function* (uri) {
      for (const session of folders.values()) yield* session.diagnosticsFor(uri);
    }),
    watcher.onDidCreate(changed),
    watcher.onDidDelete(changed),
    vscode.workspace.onDidOpenTextDocument((document) => {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (folder) folders.get(folder.uri.toString())?.open(document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const suffix = path.extname(document.fileName).slice(1).toLowerCase();
      if (suffix === 'json' || sourceSuffixes.has(suffix)) changed(document.uri);
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        changed(file.oldUri);
        changed(file.newUri);
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) changed(uri);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
      for (const folder of removed) {
        const key = folder.uri.toString();
        folders.get(key)?.dispose();
        folders.delete(key);
      }
      added.forEach(add);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('backendCheckers')) for (const session of folders.values()) session.schedule();
    }),
    vscode.commands.registerCommand('backendCheckers.scan', async () => {
      for (const session of folders.values()) await session.scanNow();
    }),
    vscode.commands.registerCommand('backendCheckers.showOutput', () => output.show()),
    {
      dispose() {
        for (const session of folders.values()) session.dispose();
        folders.clear();
      },
    },
  );
  for (const folder of vscode.workspace.workspaceFolders ?? []) add(folder);
}

module.exports = { activate };
