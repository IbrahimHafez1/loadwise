import type { Memento } from './dismissal.cjs';
import type { SourceDocument } from './source-document.cjs';

// The part of the VS Code extension API the Loadwise extension uses. VS Code ships its own typings
// with the editor, not with this package, so the members are declared here and checked against how
// the extension calls them.

export interface EditorPosition {
  line: number;
  character: number;
  isEqual(other: EditorPosition): boolean;
}

export interface EditorRange {
  start: EditorPosition;
  end: EditorPosition;
  contains(position: EditorPosition): boolean;
}

export interface EditorUri {
  scheme: string;
  fsPath: string;
  toString(): string;
}

export interface EditorLocation {
  uri: EditorUri;
  range: EditorRange;
}

export interface EditorDocument extends SourceDocument {
  uri: EditorUri;
  fileName: string;
  eol: number;
  getText(): string;
  validateRange(range: EditorRange): EditorRange;
  getWordRangeAtPosition(position: EditorPosition): EditorRange | undefined;
}

export interface EditorRelatedInformation {
  location: EditorLocation;
  message: string;
}

export interface EditorDiagnostic {
  range: EditorRange;
  message: string;
  severity: number;
  source?: string;
  code?: string;
  relatedInformation?: EditorRelatedInformation[];
}

export interface EditorDiagnosticCollection {
  get(uri: EditorUri): readonly EditorDiagnostic[] | undefined;
  set(uri: EditorUri, diagnostics: readonly EditorDiagnostic[] | undefined): void;
  set(entries: readonly [EditorUri, readonly EditorDiagnostic[] | undefined][]): void;
  forEach(callback: (uri: EditorUri, diagnostics: readonly EditorDiagnostic[]) => void): void;
  clear(): void;
  dispose(): void;
}

export interface EditorDisposable {
  dispose(): void;
}

export type EditorEvent<Payload> = (listener: (payload: Payload) => void) => EditorDisposable;

export interface EditorEventEmitter<Payload> extends EditorDisposable {
  event: EditorEvent<Payload>;
  fire(payload: Payload): void;
}

export interface EditorCommand {
  command: string;
  title: string;
  arguments?: unknown[];
}

export interface EditorCodeActionKind {
  append(part: string): EditorCodeActionKind;
  intersects(other: EditorCodeActionKind): boolean;
}

export interface EditorWorkspaceEdit {
  createFile(uri: EditorUri, options: { ignoreIfExists: boolean }): void;
  insert(uri: EditorUri, position: EditorPosition, text: string): void;
  replace(uri: EditorUri, range: EditorRange, text: string): void;
}

export interface EditorCodeAction {
  diagnostics?: EditorDiagnostic[];
  isPreferred?: boolean;
  command?: EditorCommand;
  edit?: EditorWorkspaceEdit;
}

export interface EditorCodeLens {
  range: EditorRange;
}

export interface EditorMarkdownString {
  isTrusted?: { enabledCommands: readonly string[] };
  supportThemeIcons?: boolean;
  appendText(text: string): void;
  appendMarkdown(text: string): void;
  appendCodeblock(code: string, language?: string): void;
}

export interface EditorHover {
  range?: EditorRange;
}

export interface EditorConfiguration {
  get<Value>(key: string, fallback: Value): Value;
}

export interface EditorWorkspaceFolder {
  uri: EditorUri;
  name: string;
}

export interface EditorFileWatcher extends EditorDisposable {
  onDidCreate: EditorEvent<EditorUri>;
  onDidChange: EditorEvent<EditorUri>;
  onDidDelete: EditorEvent<EditorUri>;
}

export interface EditorTextEditor {
  document: EditorDocument;
  selection: { active: EditorPosition };
}

export interface EditorQuickPickItem {
  label: string;
}

export interface EditorOutputChannel extends EditorDisposable {
  appendLine(line: string): void;
  show(): void;
}

export interface EditorStatusBarItem extends EditorDisposable {
  command?: string;
  name?: string;
  text?: string;
  tooltip?: string;
  show(): void;
}

export interface EditorCodeActionProvider {
  provideCodeActions(
    document: EditorDocument,
    range: EditorRange,
    context: { only?: EditorCodeActionKind },
  ): EditorCodeAction[] | Promise<EditorCodeAction[]>;
}

export interface EditorCodeLensProvider {
  onDidChangeCodeLenses: EditorEvent<void>;
  provideCodeLenses(document: EditorDocument): EditorCodeLens[];
}

export interface EditorHoverProvider {
  provideHover(document: EditorDocument, position: EditorPosition): EditorHover | undefined;
}

export interface EditorDocumentSelector {
  scheme: string;
}

/** The slice of the `vscode` module the extension uses. */
export interface EditorApi {
  Range: new (startLine: number, startCharacter: number, endLine: number, endCharacter: number) => EditorRange;
  Position: new (line: number, character: number) => EditorPosition;
  Uri: { file(path: string): EditorUri };
  Location: new (uri: EditorUri, range: EditorRange) => EditorLocation;
  Diagnostic: new (range: EditorRange, message: string, severity: number) => EditorDiagnostic;
  DiagnosticRelatedInformation: new (location: EditorLocation, message: string) => EditorRelatedInformation;
  DiagnosticSeverity: Record<string, number>;
  EndOfLine: { CRLF: number };
  StatusBarAlignment: { Left: number };
  CodeActionKind: { QuickFix: EditorCodeActionKind; SourceFixAll: EditorCodeActionKind };
  CodeAction: new (title: string, kind: EditorCodeActionKind) => EditorCodeAction;
  CodeLens: new (range: EditorRange, command: EditorCommand) => EditorCodeLens;
  MarkdownString: new () => EditorMarkdownString;
  Hover: new (contents: readonly EditorMarkdownString[], range?: EditorRange) => EditorHover;
  WorkspaceEdit: new () => EditorWorkspaceEdit;
  EventEmitter: new <Payload = void>() => EditorEventEmitter<Payload>;
  RelativePattern: new (folder: EditorWorkspaceFolder, pattern: string) => object;
  Disposable: { from(...disposables: EditorDisposable[]): EditorDisposable };
  commands: {
    registerCommand<Arguments extends unknown[]>(
      command: string,
      callback: (...args: Arguments) => unknown,
    ): EditorDisposable;
    executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
  };
  window: {
    activeTextEditor: EditorTextEditor | undefined;
    showWarningMessage(message: string): void;
    showInformationMessage(message: string): void;
    showQuickPick<Item extends EditorQuickPickItem>(
      items: readonly Item[],
      options: { placeHolder: string },
    ): PromiseLike<Item | undefined>;
    createOutputChannel(name: string): EditorOutputChannel;
    createStatusBarItem(alignment: number): EditorStatusBarItem;
  };
  workspace: {
    textDocuments: readonly EditorDocument[];
    workspaceFolders: readonly EditorWorkspaceFolder[] | undefined;
    isTrusted: boolean;
    fs: { readFile(uri: EditorUri): PromiseLike<Uint8Array> };
    openTextDocument(uri: EditorUri): PromiseLike<EditorDocument>;
    applyEdit(edit: EditorWorkspaceEdit): PromiseLike<boolean>;
    getConfiguration(section: string, scope?: EditorUri): EditorConfiguration;
    getWorkspaceFolder(uri: EditorUri): EditorWorkspaceFolder | undefined;
    asRelativePath(path: string): string;
    findFiles(include: object, exclude: string, maxResults: number): PromiseLike<readonly EditorUri[]>;
    createFileSystemWatcher(glob: string): EditorFileWatcher;
    onDidOpenTextDocument: EditorEvent<EditorDocument>;
    onDidSaveTextDocument: EditorEvent<EditorDocument>;
    onDidRenameFiles: EditorEvent<{ files: readonly { oldUri: EditorUri; newUri: EditorUri }[] }>;
    onDidDeleteFiles: EditorEvent<{ files: readonly EditorUri[] }>;
    onDidChangeWorkspaceFolders: EditorEvent<{
      added: readonly EditorWorkspaceFolder[];
      removed: readonly EditorWorkspaceFolder[];
    }>;
    onDidChangeConfiguration: EditorEvent<{ affectsConfiguration(section: string): boolean }>;
  };
  languages: {
    createDiagnosticCollection(name: string): EditorDiagnosticCollection;
    registerCodeActionsProvider(
      selector: EditorDocumentSelector,
      provider: EditorCodeActionProvider,
      metadata: { providedCodeActionKinds: readonly EditorCodeActionKind[] },
    ): EditorDisposable;
    registerCodeLensProvider(selector: EditorDocumentSelector, provider: EditorCodeLensProvider): EditorDisposable;
    registerHoverProvider(selector: EditorDocumentSelector, provider: EditorHoverProvider): EditorDisposable;
  };
}

/** What VS Code hands `activate`. */
export interface EditorExtensionContext {
  workspaceState: Memento;
  extensionPath: string;
  subscriptions: EditorDisposable[];
}
