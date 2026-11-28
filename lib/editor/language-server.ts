// `loadwise lsp`: the language server every editor uses. It runs the checkers on each workspace
// folder, publishes their findings as diagnostics, and offers hovers, fixes, dismissals and code
// lenses over the Language Server Protocol on stdin and stdout.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import packageManifest from '../../package.json' with { type: 'json' };
import {
  CodeActionKind,
  CodeLensRefreshRequest,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  ClientCapabilities,
  Connection,
  Diagnostic,
  FileEvent,
  InitializeParams,
  InitializeResult,
  WorkDoneProgressServerReporter,
  WorkspaceFolder,
} from 'vscode-languageserver/node';
import { codeActions, codeLenses, commands, fixAllKind } from './actions.js';
import { buildDiagnostics, hoverFor } from './diagnostics.js';
import { createDismissals } from './dismissals.js';
import { createEditorDocument, readDiskDocument } from './editor-document.js';
import { createScanSession } from './scan-session.js';
import { classifyChange, watchedGlobs } from './workspace-files.js';
import { runCommand } from './server-commands.js';
import type { PublishedFinding } from './diagnostics.js';
import type { EditorDocument } from './editor-document.js';
import type { FixWorkspace } from './fix-edits.js';
import type { LoadwiseSettings, ScanSession } from './scan-session.js';
import type { Dismissals } from './types/dismissal.js';
import { isRecord } from '../shared/is-record.js';

/** One workspace folder: its scans, dismissals and the diagnostics last built from them. */
export interface FolderState {
  root: string;
  uri: string;
  name: string;
  session: ScanSession;
  dismissals: Dismissals;
  entries: PublishedFinding[];
  /** The folder's own settings, read with workspace/configuration. */
  folderSettings: Partial<LoadwiseSettings>;
}

/** What the command handlers need from the running server. */
export interface ServerContext {
  connection: Connection;
  folders(): Iterable<FolderState>;
  folderFor(filename: string): FolderState | undefined;
  entriesFor(uri: string): PublishedFinding[];
  fixWorkspace(): FixWorkspace;
  republish(folder: FolderState): void;
}

const usage = 'Usage: loadwise lsp [--stdio]';
const defaultCli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const severities = new Set(['default', 'error', 'warning', 'information', 'hint']);
const defaultSettings: LoadwiseSettings = { enabled: true, project: '', cli: '', severity: 'default', codeLens: true };

function settingsFrom(value: unknown): Partial<LoadwiseSettings> {
  const section = isRecord(value) && isRecord(value.loadwise) ? value.loadwise : value;
  if (!isRecord(section)) return {};
  const settings: Partial<LoadwiseSettings> = {};
  if (typeof section.enabled === 'boolean') settings.enabled = section.enabled;
  if (typeof section.project === 'string') settings.project = section.project;
  if (typeof section.cli === 'string') settings.cli = section.cli;
  if (typeof section.severity === 'string' && severities.has(section.severity)) settings.severity = section.severity;
  if (typeof section.codeLens === 'boolean') settings.codeLens = section.codeLens;
  return settings;
}

// Windows paths compare case-insensitively, and editors spell drive letters differently.
function fileKey(filename: string): string {
  const resolved = path.resolve(filename);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function filenameOf(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function isInside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function parseArguments(args: readonly string[]): void {
  // Editors pass the transport flag; the parent process id is read by the protocol library itself.
  const unknown = args.filter((arg) => arg !== '--stdio' && !arg.startsWith('--clientProcessId'));
  if (unknown.length) throw new Error(usage);
}

function serverCapabilities(): InitializeResult['capabilities'] {
  return {
    textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
    hoverProvider: true,
    codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, fixAllKind] },
    codeLensProvider: { resolveProvider: false },
    executeCommandProvider: { commands: Object.values(commands) },
    workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
  };
}

function startServer(connection: Connection): void {
  const documents = new TextDocuments(TextDocument);
  const openUris = new Map<string, string>();
  const savedVersions = new Map<string, number>();
  const folders = new Map<string, FolderState>();
  const published = new Map<string, string>();
  let capabilities: ClientCapabilities = {};
  let initialSettings: Partial<LoadwiseSettings> = {};
  let pushedSettings: Partial<LoadwiseSettings> = {};
  let progress: WorkDoneProgressServerReporter | undefined;
  let progressStarting = false;
  let disposed = false;

  function settingsFor(folder: FolderState): LoadwiseSettings {
    return { ...defaultSettings, ...initialSettings, ...pushedSettings, ...folder.folderSettings };
  }
  function documentFor(filename: string): EditorDocument | undefined {
    const key = fileKey(filename);
    const uri = openUris.get(key);
    const open = uri === undefined ? undefined : documents.get(uri);
    if (!open) return readDiskDocument(filename);
    return createEditorDocument(filename, open.getText(), {
      languageId: open.languageId,
      version: open.version,
      isDirty: savedVersions.get(key) !== open.version,
    });
  }
  function uriFor(filename: string): string {
    return openUris.get(fileKey(filename)) ?? pathToFileURL(filename).href;
  }
  function folderFor(filename: string): FolderState | undefined {
    let best: FolderState | undefined;
    for (const folder of folders.values()) {
      if (isInside(folder.root, filename) && (!best || folder.root.length > best.root.length)) best = folder;
    }
    return best;
  }
  function entriesFor(uri: string): PublishedFinding[] {
    const filename = filenameOf(uri);
    if (filename === undefined) return [];
    const key = fileKey(filename);
    return [...folders.values()].flatMap((folder) => folder.entries.filter((entry) => fileKey(entry.filename) === key));
  }
  function fixWorkspace(): FixWorkspace {
    const workspaceEdit = capabilities.workspace?.workspaceEdit;
    const supportsDocumentChanges = workspaceEdit?.documentChanges === true;
    return {
      documentFor,
      uriFor,
      keyOf: fileKey,
      supportsDocumentChanges,
      canCreateFiles: supportsDocumentChanges && Boolean(workspaceEdit?.resourceOperations?.includes('create')),
    };
  }

  function refreshCodeLenses(): void {
    if (!capabilities.workspace?.codeLens?.refreshSupport) return;
    connection.sendRequest(CodeLensRefreshRequest.type).catch(() => {});
  }
  // Unchanged files are not resent, and files whose findings are gone get an empty list.
  function sendDiagnostics(): void {
    const next = new Map<string, Diagnostic[]>();
    for (const folder of folders.values()) {
      for (const entry of folder.entries) {
        const list = next.get(entry.uri);
        if (list) list.push(entry.diagnostic);
        else next.set(entry.uri, [entry.diagnostic]);
      }
    }
    for (const uri of published.keys()) {
      if (next.has(uri)) continue;
      published.delete(uri);
      connection.sendDiagnostics({ uri, diagnostics: [] }).catch(() => {});
    }
    for (const [uri, diagnostics] of next) {
      const text = JSON.stringify(diagnostics);
      if (published.get(uri) === text) continue;
      published.set(uri, text);
      connection.sendDiagnostics({ uri, diagnostics }).catch(() => {});
    }
    refreshCodeLenses();
  }
  function republish(folder: FolderState): void {
    const settings = settingsFor(folder);
    // One read per file for the whole report, however many findings it has.
    const read = new Map<string, EditorDocument | undefined>();
    const cachedDocumentFor = (filename: string) => {
      const key = fileKey(filename);
      if (!read.has(key)) read.set(key, documentFor(filename));
      return read.get(key);
    };
    folder.entries = [...folder.session.reports()].flatMap(({ source, findings }) =>
      buildDiagnostics(folder.root, source, findings, {
        isDismissed: (entry) => folder.dismissals.has(entry),
        severity: settings.severity,
        documentFor: cachedDocumentFor,
        uriFor,
      }),
    );
    sendDiagnostics();
  }
  function republishAll(): void {
    for (const folder of folders.values()) republish(folder);
  }

  function updateProgress(): void {
    const scanning = [...folders.values()].some((folder) => folder.session.isScanning());
    if (!scanning && progress) {
      progress.done();
      progress = undefined;
    }
    if (!scanning || progress || progressStarting) return;
    progressStarting = true;
    connection.window.createWorkDoneProgress().then(
      (reporter) => {
        progressStarting = false;
        progress = reporter;
        reporter.begin('Loadwise', undefined, 'Scanning');
        updateProgress();
      },
      () => {
        progressStarting = false;
      },
    );
  }

  async function pullSettings(folder: FolderState): Promise<void> {
    if (!capabilities.workspace?.configuration) return;
    try {
      folder.folderSettings = settingsFrom(
        await connection.workspace.getConfiguration({ scopeUri: folder.uri, section: 'loadwise' }),
      );
    } catch (error) {
      connection.console.error('Could not read the loadwise settings: ' + String(error));
    }
  }
  async function addFolder({ uri, name }: WorkspaceFolder): Promise<void> {
    const root = filenameOf(uri);
    if (root === undefined || folders.has(fileKey(root)) || disposed) return;
    const folder: FolderState = {
      root,
      uri,
      name,
      dismissals: createDismissals(root),
      entries: [],
      folderSettings: {},
      session: createScanSession({
        root,
        name,
        defaultCli,
        settings: () => settingsFor(folder),
        log: (text) => connection.console.info(text),
        logError: (text) => connection.console.error(text),
        onReports: () => republish(folder),
        onStatus: updateProgress,
      }),
    };
    folders.set(fileKey(root), folder);
    await pullSettings(folder);
    folder.session.schedule();
  }
  function removeFolder({ uri }: WorkspaceFolder): void {
    const root = filenameOf(uri);
    const folder = root === undefined ? undefined : folders.get(fileKey(root));
    if (!folder || root === undefined) return;
    folder.session.dispose();
    folders.delete(fileKey(root));
    sendDiagnostics();
    updateProgress();
  }
  function disposeAll(): void {
    disposed = true;
    for (const folder of folders.values()) folder.session.dispose();
    folders.clear();
  }

  // Groups the changes of one notification, so each folder rescans once.
  function filesChanged(changes: readonly { filename: string; type: FileChangeType }[]): void {
    const touched = new Map<FolderState, { restart: boolean; filesAddedOrRemoved: boolean; scan: boolean }>();
    for (const { filename, type } of changes) {
      const folder = folderFor(filename);
      if (!folder) continue;
      const kind = classifyChange(folder.root, filename);
      if (kind === 'ignored') continue;
      const flags = touched.get(folder) ?? { restart: false, filesAddedOrRemoved: false, scan: false };
      touched.set(folder, flags);
      if (kind === 'dismissals') {
        folder.dismissals.reload();
        republish(folder);
        continue;
      }
      flags.scan = true;
      flags.restart ||= kind === 'config';
      flags.filesAddedOrRemoved ||= type !== FileChangeType.Changed;
    }
    for (const [folder, { scan, ...options }] of touched) if (scan) folder.session.schedule(options);
  }
  function watchedFileEvents(events: readonly FileEvent[]): { filename: string; type: FileChangeType }[] {
    return events.flatMap(({ uri, type }) => {
      const filename = filenameOf(uri);
      return filename === undefined ? [] : [{ filename, type }];
    });
  }

  function documentOpened(uri: string, version: number): void {
    const filename = filenameOf(uri);
    if (filename === undefined) return;
    openUris.set(fileKey(filename), uri);
    savedVersions.set(fileKey(filename), version);
    const folder = folderFor(filename);
    if (folder) republish(folder);
  }
  function documentClosed(uri: string): void {
    const filename = filenameOf(uri);
    if (filename === undefined) return;
    openUris.delete(fileKey(filename));
    savedVersions.delete(fileKey(filename));
    const folder = folderFor(filename);
    if (folder) republish(folder);
  }

  const context: ServerContext = {
    connection,
    folders: () => folders.values(),
    folderFor,
    entriesFor,
    fixWorkspace,
    republish,
  };

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    capabilities = params.capabilities;
    initialSettings = settingsFrom(params.initializationOptions);
    const rootFilename = params.rootUri ? filenameOf(params.rootUri) : undefined;
    const rootFolder =
      params.rootUri && rootFilename ? [{ uri: params.rootUri, name: path.basename(rootFilename) }] : [];
    const initialFolders = params.workspaceFolders ?? rootFolder;
    connection.onInitialized(async () => {
      // A client that advertises dynamic registration can still refuse it; the folders are scanned either way.
      if (capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
        await connection.client
          .register(DidChangeWatchedFilesNotification.type, {
            watchers: watchedGlobs.map((globPattern) => ({ globPattern })),
          })
          .catch((error: unknown) => connection.console.error('Could not watch files: ' + String(error)));
      }
      if (capabilities.workspace?.didChangeConfiguration?.dynamicRegistration) {
        await connection.client
          .register(DidChangeConfigurationNotification.type, { section: 'loadwise' })
          .catch((error: unknown) =>
            connection.console.error('Could not watch the loadwise settings: ' + String(error)),
          );
      }
      if (capabilities.workspace?.workspaceFolders) {
        connection.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
          removed.forEach(removeFolder);
          for (const folder of added) void addFolder(folder);
        });
      }
      await Promise.all(initialFolders.map(addFolder));
    });
    return { capabilities: serverCapabilities(), serverInfo: { name: 'loadwise', version: packageManifest.version } };
  });

  documents.onDidOpen(({ document }) => documentOpened(document.uri, document.version));
  documents.onDidClose(({ document }) => documentClosed(document.uri));
  documents.onDidSave(({ document }) => {
    const filename = filenameOf(document.uri);
    if (filename === undefined) return;
    savedVersions.set(fileKey(filename), document.version);
    filesChanged([{ filename, type: FileChangeType.Changed }]);
  });
  connection.onDidChangeWatchedFiles(({ changes }) => filesChanged(watchedFileEvents(changes)));
  connection.onDidChangeConfiguration(async ({ settings }) => {
    if (settings !== null && settings !== undefined) pushedSettings = settingsFrom(settings);
    await Promise.all([...folders.values()].map(pullSettings));
    republishAll();
    for (const folder of folders.values()) folder.session.schedule({ restart: true });
  });

  connection.onHover(({ textDocument, position }) => {
    const filename = filenameOf(textDocument.uri);
    const document = filename === undefined ? undefined : documentFor(filename);
    if (!document) return null;
    const hover = hoverFor(document, entriesFor(textDocument.uri), position);
    return hover ? { contents: { kind: 'markdown', value: hover.markdown }, range: hover.range } : null;
  });
  connection.onCodeAction(({ textDocument, range, context: actionContext }) =>
    codeActions(entriesFor(textDocument.uri), range, actionContext.only, textDocument.uri, fixWorkspace()),
  );
  connection.onCodeLens(({ textDocument }) => {
    const filename = filenameOf(textDocument.uri);
    const folder = filename === undefined ? undefined : folderFor(filename);
    if (!folder || !settingsFor(folder).codeLens) return [];
    return codeLenses(entriesFor(textDocument.uri), textDocument.uri);
  });
  connection.onExecuteCommand(({ command, arguments: commandArguments }) =>
    runCommand(context, command, commandArguments ?? []),
  );

  connection.onShutdown(disposeAll);
  connection.onExit(disposeAll);
  // The protocol library exits the process when the editor goes away; the checkers must not outlive it.
  process.on('exit', disposeAll);
  documents.listen(connection);
  connection.listen();
}

function runLanguageServer(args: readonly string[]): number {
  parseArguments(args);
  startServer(createConnection(process.stdin, process.stdout));
  return 0;
}

export { runLanguageServer };
