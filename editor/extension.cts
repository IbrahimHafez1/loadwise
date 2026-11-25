import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { publish, refreshDocument, registerCodeLenses, registerExamples, registerQuickFixes } from './diagnostics.cjs';
import { createDismissals } from './dismissals.cjs';
import { startPerfWatch } from './perf-watch.cjs';
import type { PerfWatchHandle } from './perf-watch.cjs';
import type { Finding } from '../lib/shared/types.js';
import type { DismissalEntry } from './types/dismissal.cjs';
import type { PublishOptions } from './types/publish-options.cjs';
import type {
  EditorConfiguration,
  EditorDiagnostic,
  EditorDiagnosticCollection,
  EditorDocument,
  EditorExtensionContext,
  EditorOutputChannel,
  EditorUri,
  EditorWorkspaceFolder,
} from './types/vscode-api.cjs';
import * as vscode from 'vscode';

const run = promisify(execFile);
const debounceMs = 650;
const maxReportBytes = 64 * 1024 * 1024;
const perf = 'loadwise perf';
const maint = 'loadwise maint';
const polyglotGlob = '**/*.{py,go,java,cs,rs}';
const sourceSuffixes = new Set(
  'js jsx ts tsx mjs mts cjs cts py go java cs rs rb php kt kts c h cc cpp cxx hpp hh hxx'.split(' '),
);
const sourceGlob = '**/*.{' + [...sourceSuffixes].join(',') + '}';
// Inputs besides source files that change findings. A change restarts the incremental watcher as
// well.
const configGlob =
  '**/{schema.prisma,package.json,tsconfig*.json,jsconfig*.json,loadwise.config.json,maintainability.config.json,backend-perf.policy.json,*.sql,migrations}';
const ignored = new Set(
  '.git node_modules dist build coverage .next .nuxt .venv venv __pycache__ target vendor'.split(' '),
);
const excludeGlob = '**/{' + [...ignored].join(',') + '}/**';
const scanEnv = { ...process.env, BACKEND_CHECKERS_EDITOR_SCAN: '1' };

/** What the editor lists for one checker run on a folder. */
interface ScanTask {
  id: string;
  source: string;
  args: string[] | null;
  watch?: boolean;
}

/** The incremental watcher of one folder; `pending` is set until its first report. */
interface ActivePerfWatch {
  key: string;
  pending: boolean;
  handle?: PerfWatchHandle;
}

interface MonitorHooks {
  publishOptions(folder: EditorWorkspaceFolder): PublishOptions;
  onStatus(): void;
}

interface MonitorStatus {
  scanning: boolean;
  findings: number;
  lastScan: Date | undefined;
}

/** One workspace folder's scans and the diagnostics they publish. */
interface MonitorSession {
  schedule(options?: { restart?: boolean }): void;
  diagnosticsFor(uri: EditorUri): Generator<EditorDiagnostic>;
  open(document: EditorDocument): void;
  republish(): void;
  status(): MonitorStatus;
  scanNow(): Promise<void>;
  dispose(): void;
}

/**
 * A failed child process: `execFile` rejects with an Error that also carries the exit code and
 * output.
 */
interface ExecFailure {
  message: string;
  code: unknown;
  stdout: string | undefined;
  stderr: string | undefined;
}

interface DismissedPick {
  label: string;
  description?: string;
  detail?: string;
  entries: DismissalEntry[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function execFailureOf(error: unknown): ExecFailure {
  if (!(error instanceof Error)) throw error;
  return {
    message: error.message,
    code: 'code' in error ? error.code : undefined,
    stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : undefined,
    stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : undefined,
  };
}

function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function firstExisting(root: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) if (await exists(path.join(root, name))) return name;
}

async function readFindings(
  script: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<Finding[]> {
  const options: ExecFileOptionsWithStringEncoding = {
    cwd,
    signal,
    windowsHide: true,
    maxBuffer: maxReportBytes,
    encoding: 'utf8',
    env: scanEnv,
  };
  let stdout: string;
  try {
    ({ stdout } = await run('node', [script, ...args, '--json'], options));
  } catch (error) {
    const failure = execFailureOf(error);
    if (failure.code !== 1) throw new Error(failure.stderr?.trim() || failure.message, { cause: error });
    stdout = failure.stdout ?? '';
  }
  const report: { findings?: unknown } = JSON.parse(stdout);
  if (!Array.isArray(report.findings)) throw new Error('Checker returned an invalid findings report.');
  return report.findings;
}

function monitor(
  folder: EditorWorkspaceFolder,
  extensionPath: string,
  output: EditorOutputChannel,
  { publishOptions, onStatus }: MonitorHooks,
): MonitorSession {
  const root = folder.uri.fsPath;
  const signal = new AbortController();
  const collections = new Map<string, EditorDiagnosticCollection>();
  // The last findings of each checker, so dismissing or restoring one republishes without a rescan.
  const reports = new Map<string, { source: string; findings: Finding[] }>();
  let revision = 0;
  let scannedRevision = -1;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let activeScan: AbortController | undefined;
  let scanning = false;
  let lastScan: Date | undefined;
  let restartRequested = false;
  let perfWatch: ActivePerfWatch | undefined;
  // Set when the watcher dies; full rescans take over until a config change restarts it.
  let watchUnavailable = false;

  function log(id: string, text: string): void {
    output.appendLine(folder.name + ' / ' + id + ' — ' + text);
  }
  function collection(id: string): EditorDiagnosticCollection {
    let existing = collections.get(id);
    if (!existing) {
      existing = vscode.languages.createDiagnosticCollection(id);
      collections.set(id, existing);
    }
    return existing;
  }
  function show(id: string, source: string, findings: Finding[]): void {
    reports.set(id, { source, findings });
    publish(vscode, collection(id), root, source, findings, publishOptions(folder));
    lastScan = new Date();
    log(id, findings.length + ' finding(s)');
    onStatus();
  }
  function clear(id: string): void {
    reports.delete(id);
    collection(id).clear();
  }
  function stopWatch() {
    perfWatch?.handle?.stop();
    perfWatch = undefined;
  }
  function ensureWatch(script: string, project: string, restart: boolean): void {
    const key = script + '\0' + project;
    if (perfWatch?.key === key && !restart) return;
    stopWatch();
    log(perf, 'watching ' + project + ' incrementally');
    const current: ActivePerfWatch = { key, pending: true };
    current.handle = startPerfWatch({
      script,
      project,
      cwd: root,
      env: scanEnv,
      onFindings(findings: Finding[]) {
        if (perfWatch !== current) return;
        current.pending = false;
        show(perf, perf, findings);
      },
      onError(error: Error) {
        if (perfWatch !== current) return;
        // A config or project error produces no report; stop showing the scan as in progress.
        current.pending = false;
        log(perf, error.message);
        onStatus();
      },
      onExit(error: Error) {
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
  function findOne(glob: string): PromiseLike<boolean> {
    return vscode.workspace
      .findFiles(new vscode.RelativePattern(folder, glob), excludeGlob, 1)
      .then((files) => files.length > 0);
  }
  async function workspaceScanTasks(
    settings: EditorConfiguration,
  ): Promise<{ project: string | undefined; tasks: ScanTask[] }> {
    const rawExplicitProject = settings.get<string>('project', '').trim();
    let explicitProject = '';
    if (rawExplicitProject && !rawExplicitProject.startsWith('-')) {
      const candidate = path.resolve(root, rawExplicitProject);
      const rel = path.relative(root, candidate);
      if (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) {
        explicitProject = rel;
      }
    }
    const project = explicitProject || (await firstExisting(root, ['tsconfig.json', 'jsconfig.json']));
    const hasMaintainabilityInput =
      project || (await exists(path.join(root, 'maintainability.config.json'))) || (await findOne(sourceGlob));
    const hasPolyglotInput = await findOne(polyglotGlob);
    const tasks: ScanTask[] = [
      { id: perf, source: perf, args: project ? ['perf', '-p', project] : null, watch: true },
      { id: maint, source: maint, args: hasMaintainabilityInput ? ['maint', '.'] : null },
      { id: perf + '-polyglot', source: perf, args: hasPolyglotInput ? ['perf', 'polyglot', '.'] : null },
    ];
    return { project, tasks };
  }
  async function scan(version: number, scanSignal: AbortSignal): Promise<void> {
    const restart = restartRequested;
    restartRequested = false;
    if (restart) watchUnavailable = false;
    const settings = vscode.workspace.getConfiguration('loadwise', folder.uri);
    if (!settings.get('enabled', true) || !vscode.workspace.isTrusted) {
      stopWatch();
      for (const id of collections.keys()) clear(id);
      return;
    }
    const { project, tasks } = await workspaceScanTasks(settings);
    for (const { id, source, args, watch } of tasks) {
      if (signal.signal.aborted || version !== revision) return;
      if (!args) {
        if (watch) stopWatch();
        clear(id);
        continue;
      }
      const script =
        settings.get<string>('cli', '') || path.join(extensionPath, 'tools', 'loadwise', 'bin', 'loadwise.cjs');
      try {
        if (!path.isAbsolute(script)) throw new Error('CLI override must be an absolute path.');
        if (watch && !watchUnavailable && project) {
          ensureWatch(script, project, restart);
          continue;
        }
        const findings = await readFindings(script, args, root, scanSignal);
        if (version !== revision || signal.signal.aborted) return;
        show(id, source, findings);
      } catch (error) {
        if (signal.signal.aborted || version !== revision) return;
        clear(id);
        log(id, messageOf(error));
      }
    }
  }
  function abortStaleScan(): void {
    activeScan?.abort();
  }
  async function runScan(): Promise<void> {
    const version = revision;
    if (signal.signal.aborted || version === scannedRevision) return;
    scannedRevision = version;
    activeScan = new AbortController();
    scanning = true;
    onStatus();
    try {
      await scan(version, activeScan.signal);
    } catch (error) {
      if (!signal.signal.aborted && version === revision) output.appendLine(folder.name + ' — ' + messageOf(error));
    } finally {
      activeScan = undefined;
      scanning = false;
      onStatus();
    }
  }
  function start(): Promise<void> {
    clearTimeout(timer);
    // A stale scan is aborted by schedule(); wait for it to wind down, then scan the newest state
    // once.
    const previous = running;
    const current: Promise<void> = (previous ?? Promise.resolve()).then(runScan).finally(() => {
      if (running === current) running = undefined;
    });
    running = current;
    return current;
  }
  function schedule({ restart = false }: { restart?: boolean } = {}): void {
    if (signal.signal.aborted) return;
    restartRequested ||= restart;
    revision++;
    clearTimeout(timer);
    abortStaleScan();
    // A config change makes the running watcher stale too; the debounced follow-up starts a fresh
    // one.
    if (restart) stopWatch();
    timer = setTimeout(start, debounceMs);
  }
  return {
    schedule,
    *diagnosticsFor(uri: EditorUri): Generator<EditorDiagnostic> {
      for (const diagnostics of collections.values()) yield* diagnostics.get(uri) ?? [];
    },
    open(document: EditorDocument) {
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
      schedule({ restart: true });
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

function statusText(sessions: Iterable<MonitorSession>): { text: string; tooltip: string } {
  let scanning = false;
  let findings = 0;
  let lastScan: Date | undefined;
  for (const session of sessions) {
    const status = session.status();
    scanning ||= status.scanning;
    findings += status.findings;
    if (status.lastScan && !(lastScan !== undefined && lastScan > status.lastScan)) lastScan = status.lastScan;
  }
  if (scanning) return { text: '$(sync~spin) Loadwise: scanning', tooltip: 'Click to show the output.' };
  const time = lastScan ? ' · ' + lastScan.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return {
    text: '$(checklist) ' + findings + ' finding' + (findings === 1 ? '' : 's') + time,
    tooltip:
      (lastScan ? 'Loadwise last scanned at ' + lastScan.toLocaleTimeString() + '. ' : '') +
      'Click to show the output.',
  };
}

function activate(context: EditorExtensionContext): void {
  const folders = new Map<string, MonitorSession>();
  const output = vscode.window.createOutputChannel('Loadwise');
  const dismissals = createDismissals(context.workspaceState);
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusItem.command = 'loadwise.showOutput';
  statusItem.name = 'Loadwise';
  // Every publish ends in a status update, so the buttons above fixable lines refresh with it.
  const codeLenses = registerCodeLenses(vscode, allDiagnostics);
  function updateStatus() {
    Object.assign(statusItem, statusText(folders.values()));
    codeLenses.refresh();
  }
  updateStatus();
  statusItem.show();
  const hooks: MonitorHooks = {
    publishOptions: (folder) => ({
      isDismissed: (site: DismissalEntry) => dismissals.has(site),
      severity: vscode.workspace.getConfiguration('loadwise', folder.uri).get<string>('severity', 'default'),
    }),
    onStatus: updateStatus,
  };
  function add(folder: EditorWorkspaceFolder): void {
    if (folder.uri.scheme !== 'file') return;
    const session = monitor(folder, context.extensionPath, output, hooks);
    folders.set(folder.uri.toString(), session);
    session.schedule();
  }
  function republishAll() {
    for (const session of folders.values()) session.republish();
    updateStatus();
  }
  function changed(uri: EditorUri, restart = false): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || uri.scheme !== 'file') return;
    const segments = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep);
    if (segments.some((segment) => ignored.has(segment))) return;
    folders.get(folder.uri.toString())?.schedule({ restart });
  }
  const configChanged = (uri: EditorUri) => changed(uri, true);
  async function showDismissed() {
    const entries = dismissals.entries();
    if (!entries.length) {
      vscode.window.showInformationMessage('No Loadwise findings are dismissed.');
      return;
    }
    const items: DismissedPick[] = [
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
  function* allDiagnostics(uri: EditorUri): Generator<EditorDiagnostic> {
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
    codeLenses.disposable,
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
      if (!event.affectsConfiguration('loadwise')) return;
      republishAll();
      for (const session of folders.values()) session.schedule({ restart: true });
    }),
    vscode.commands.registerCommand('loadwise.scan', async () => {
      for (const session of folders.values()) await session.scanNow();
    }),
    vscode.commands.registerCommand('loadwise.showOutput', () => output.show()),
    vscode.commands.registerCommand('loadwise.showDismissed', showDismissed),
    {
      dispose() {
        for (const session of folders.values()) session.dispose();
        folders.clear();
      },
    },
  );
  for (const folder of vscode.workspace.workspaceFolders ?? []) add(folder);
}

export { activate };
