'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { publish, refreshDocument, registerExamples, registerQuickFixes } = require('./diagnostics.cjs');
const { createDismissals } = require('./dismissals.cjs');
const { startPerfWatch } = require('./perf-watch.cjs');

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
// Inputs besides source files that change findings. A change restarts the incremental watcher as well.
const configGlob =
  '**/{schema.prisma,package.json,tsconfig*.json,jsconfig*.json,maintainability.config.json,backend-perf.policy.json,*.sql,migrations}';
const ignored = new Set(
  '.git node_modules dist build coverage .next .nuxt .venv venv __pycache__ target vendor'.split(' '),
);
const excludeGlob = '**/{' + [...ignored].join(',') + '}/**';
const scanEnv = { ...process.env, BACKEND_CHECKERS_EDITOR_SCAN: '1' };

function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function firstExisting(root, names) {
  for (const name of names) if (await exists(path.join(root, name))) return name;
}

async function readFindings(script, args, cwd, signal) {
  const options = { cwd, signal, windowsHide: true, maxBuffer: maxReportBytes, encoding: 'utf8', env: scanEnv };
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

function monitor(folder, extensionPath, output, { publishOptions, onStatus }) {
  const root = folder.uri.fsPath;
  const signal = new AbortController();
  const collections = new Map();
  // The last findings of each checker, so dismissing or restoring one republishes without a rescan.
  const reports = new Map();
  let revision = 0;
  let scannedRevision = -1;
  let running;
  let timer;
  let activeScan;
  let scanning = false;
  let lastScan;
  let restartRequested = false;
  let perfWatch;
  // Set when the watcher dies; full rescans take over until a config change restarts it.
  let watchUnavailable = false;

  function log(id, text) {
    output.appendLine(folder.name + ' / ' + id + ' — ' + text);
  }
  function collection(id) {
    if (!collections.has(id)) collections.set(id, vscode.languages.createDiagnosticCollection(id));
    return collections.get(id);
  }
  function show(id, source, findings) {
    reports.set(id, { source, findings });
    publish(vscode, collection(id), root, source, findings, publishOptions(folder));
    lastScan = new Date();
    log(id, findings.length + ' finding(s)');
    onStatus();
  }
  function clear(id) {
    reports.delete(id);
    collection(id).clear();
  }
  function stopWatch() {
    perfWatch?.handle.stop();
    perfWatch = undefined;
  }
  function ensureWatch(script, project, restart) {
    const key = script + '\0' + project;
    if (perfWatch?.key === key && !restart) return;
    stopWatch();
    log(perf, 'watching ' + project + ' incrementally');
    const current = { key, pending: true };
    current.handle = startPerfWatch({
      script,
      project,
      cwd: root,
      env: scanEnv,
      onFindings(findings) {
        if (perfWatch !== current) return;
        current.pending = false;
        show(perf, perf, findings);
      },
      onError(error) {
        if (perfWatch !== current) return;
        // A config or project error produces no report; stop showing the scan as in progress.
        current.pending = false;
        log(perf, error.message);
        onStatus();
      },
      onExit(error) {
        if (perfWatch !== current) return;
        perfWatch = undefined;
        watchUnavailable = true;
        log(perf, error.message + ' Falling back to full rescans after each change.');
        schedule();
      },
    });
    perfWatch = current;
    onStatus();
  }
  function findOne(glob) {
    return vscode.workspace
      .findFiles(new vscode.RelativePattern(folder, glob), excludeGlob, 1)
      .then((files) => files.length > 0);
  }
  async function scan(version, scanSignal) {
    const restart = restartRequested;
    restartRequested = false;
    if (restart) watchUnavailable = false;
    const settings = vscode.workspace.getConfiguration('backendCheckers', folder.uri);
    if (!settings.get('enabled', true) || !vscode.workspace.isTrusted) {
      stopWatch();
      for (const id of collections.keys()) clear(id);
      return;
    }
    const explicitProject = settings.get('project', '');
    const project = explicitProject || (await firstExisting(root, ['tsconfig.json', 'jsconfig.json']));
    const hasMaintainabilityInput =
      project || (await exists(path.join(root, 'maintainability.config.json'))) || (await findOne(sourceGlob));
    const hasPolyglotInput = await findOne(polyglotGlob);
    const tasks = [
      { id: perf, source: perf, args: project ? ['-p', project] : null, watch: true },
      { id: maint, source: maint, args: hasMaintainabilityInput ? ['.'] : null },
      { id: perf + '-polyglot', source: perf, args: hasPolyglotInput ? ['polyglot', '.'] : null },
    ];
    for (const { id, source, args, watch } of tasks) {
      if (signal.signal.aborted || version !== revision) return;
      if (!args) {
        if (watch) stopWatch();
        clear(id);
        continue;
      }
      const override = settings.get(source === perf ? 'performanceCli' : 'maintainabilityCli', '');
      const script = override || path.join(extensionPath, 'tools', source, 'bin', source + '.cjs');
      try {
        if (!path.isAbsolute(script)) throw new Error('CLI override must be an absolute path.');
        if (watch && !watchUnavailable) {
          ensureWatch(script, project, restart);
          continue;
        }
        const findings = await readFindings(script, args, root, scanSignal);
        if (version !== revision || signal.signal.aborted) return;
        show(id, source, findings);
      } catch (error) {
        if (signal.signal.aborted || version !== revision) return;
        clear(id);
        log(id, error.message);
      }
    }
  }
  function abortStaleScan() {
    activeScan?.abort();
  }
  async function runScan() {
    const version = revision;
    if (signal.signal.aborted || version === scannedRevision) return;
    scannedRevision = version;
    activeScan = new AbortController();
    scanning = true;
    onStatus();
    try {
      await scan(version, activeScan.signal);
    } catch (error) {
      if (!signal.signal.aborted && version === revision) output.appendLine(folder.name + ' — ' + error.message);
    } finally {
      activeScan = undefined;
      scanning = false;
      onStatus();
    }
  }
  function start() {
    clearTimeout(timer);
    // A stale scan is aborted by schedule(); wait for it to wind down, then scan the newest state once.
    const previous = running;
    const current = (previous ?? Promise.resolve()).then(runScan).finally(() => {
      if (running === current) running = undefined;
    });
    running = current;
    return current;
  }
  function schedule({ restart = false } = {}) {
    restartRequested ||= restart;
    revision++;
    clearTimeout(timer);
    abortStaleScan();
    timer = setTimeout(start, debounceMs);
  }
  return {
    schedule,
    *diagnosticsFor(uri) {
      for (const diagnostics of collections.values()) yield* diagnostics.get(uri) ?? [];
    },
    open(document) {
      for (const diagnostics of collections.values()) refreshDocument(vscode, diagnostics, document);
    },
    republish() {
      for (const [id, { source, findings }] of reports)
        publish(vscode, collection(id), root, source, findings, publishOptions(folder));
    },
    status() {
      let findings = 0;
      for (const diagnostics of collections.values()) {
        diagnostics.forEach((_uri, list) => {
          findings += list.length;
        });
      }
      return { scanning: scanning || Boolean(perfWatch?.pending), findings, lastScan };
    },
    scanNow() {
      revision++;
      abortStaleScan();
      return start();
    },
    dispose() {
      clearTimeout(timer);
      signal.abort();
      abortStaleScan();
      stopWatch();
      for (const diagnostics of collections.values()) diagnostics.dispose();
    },
  };
}

function statusText(sessions) {
  let scanning = false;
  let findings = 0;
  let lastScan;
  for (const session of sessions) {
    const status = session.status();
    scanning ||= status.scanning;
    findings += status.findings;
    if (status.lastScan && !(lastScan > status.lastScan)) lastScan = status.lastScan;
  }
  if (scanning) return { text: '$(sync~spin) Backend Checkers: scanning', tooltip: 'Click to show the output.' };
  const time = lastScan ? ' · ' + lastScan.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return {
    text: '$(checklist) ' + findings + ' finding' + (findings === 1 ? '' : 's') + time,
    tooltip:
      (lastScan ? 'Backend Checkers last scanned at ' + lastScan.toLocaleTimeString() + '. ' : '') +
      'Click to show the output.',
  };
}

function activate(context) {
  const folders = new Map();
  const output = vscode.window.createOutputChannel('Backend Checkers');
  const dismissals = createDismissals(context.workspaceState);
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusItem.command = 'backendCheckers.showOutput';
  statusItem.name = 'Backend Checkers';
  function updateStatus() {
    Object.assign(statusItem, statusText(folders.values()));
  }
  updateStatus();
  statusItem.show();
  const hooks = {
    publishOptions: (folder) => ({
      isDismissed: (site) => dismissals.has(site),
      severity: vscode.workspace.getConfiguration('backendCheckers', folder.uri).get('severity', 'default'),
    }),
    onStatus: updateStatus,
  };
  function add(folder) {
    if (folder.uri.scheme !== 'file') return;
    const session = monitor(folder, context.extensionPath, output, hooks);
    folders.set(folder.uri.toString(), session);
    session.schedule();
  }
  function republishAll() {
    for (const session of folders.values()) session.republish();
    updateStatus();
  }
  function changed(uri, restart = false) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || uri.scheme !== 'file') return;
    const segments = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep);
    if (segments.some((segment) => ignored.has(segment))) return;
    folders.get(folder.uri.toString())?.schedule({ restart });
  }
  const configChanged = (uri) => changed(uri, true);
  async function showDismissed() {
    const entries = dismissals.entries();
    if (!entries.length) {
      vscode.window.showInformationMessage('No Backend Checkers findings are dismissed.');
      return;
    }
    const items = [
      { label: 'Restore all (' + entries.length + ')', entries },
      ...entries.map((entry) => ({
        label: entry.ruleId,
        description: vscode.workspace.asRelativePath(entry.file),
        detail: typeof entry.lineText === 'string' ? entry.lineText || '(blank line)' : 'Whole file',
        entries: [entry],
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a dismissed finding to show again' });
    if (!picked) return;
    await dismissals.remove(picked.entries);
    republishAll();
  }
  function* allDiagnostics(uri) {
    for (const session of folders.values()) yield* session.diagnosticsFor(uri);
  }
  const watcher = vscode.workspace.createFileSystemWatcher(sourceGlob);
  const configWatcher = vscode.workspace.createFileSystemWatcher(configGlob);
  context.subscriptions.push(
    output,
    statusItem,
    watcher,
    configWatcher,
    registerExamples(vscode, allDiagnostics),
    registerQuickFixes(vscode, { diagnosticsFor: allDiagnostics, dismissals, onDismissed: republishAll }),
    // Changes from git, other editors and code generators arrive here, not through save events.
    watcher.onDidCreate((uri) => changed(uri)),
    watcher.onDidChange((uri) => changed(uri)),
    watcher.onDidDelete((uri) => changed(uri)),
    configWatcher.onDidCreate(configChanged),
    configWatcher.onDidChange(configChanged),
    configWatcher.onDidDelete(configChanged),
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
      updateStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('backendCheckers')) return;
      republishAll();
      for (const session of folders.values()) session.schedule({ restart: true });
    }),
    vscode.commands.registerCommand('backendCheckers.scan', async () => {
      for (const session of folders.values()) await session.scanNow();
    }),
    vscode.commands.registerCommand('backendCheckers.showOutput', () => output.show()),
    vscode.commands.registerCommand('backendCheckers.showDismissed', showDismissed),
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
