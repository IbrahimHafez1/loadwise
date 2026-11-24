import {
  publish,
  refreshDocument,
  registerCodeLenses,
  registerExamples,
  registerQuickFixes,
} from '../../editor/diagnostics.cjs';
import type { Dismissals } from '../../editor/types/dismissal.cjs';
import type { PublishOptions } from '../../editor/types/publish-options.cjs';
import type { EditorApi, EditorDiagnosticCollection, EditorDocument } from '../../editor/types/vscode-api.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

// The editor tests fake the `vscode` module with plain objects and use a file path as its own URI,
// so their fakes only approximate the real EditorApi. The shapes below describe what the fakes
// provide; the wrappers at the bottom are the only place where a fake is handed to the editor
// modules, which read nothing but the members the fakes implement.

/** The tests use the file path as the URI. */
export type FakeUri = string;

export interface FakePosition {
  line: number;
  character: number;
}

export interface FakeRange {
  start: FakePosition;
  end: FakePosition;
  contains?(position: FakePosition): boolean;
}

export interface FakeDiagnostic {
  range: FakeRange;
  message: string;
  severity: number;
  code?: string;
  source?: string;
}

export interface FakeDocument {
  uri: FakeUri;
  languageId?: string;
  isDirty?: boolean;
  lineCount?: number;
  eol?: number;
  lineAt?(line: number): { text: string };
  validateRange?(range: FakeRange): FakeRange;
  getWordRangeAtPosition?(position: FakePosition): FakeRange | undefined;
  getText?(): string | undefined;
}

export type FakeDiagnosticEntries = readonly [FakeUri, readonly FakeDiagnostic[] | undefined][];

export interface FakeDiagnosticCollection {
  forEach(visit: (uri: FakeUri, diagnostics: readonly FakeDiagnostic[]) => void): void;
  get(uri: FakeUri): readonly FakeDiagnostic[] | undefined;
  set(entries: FakeUri | FakeDiagnosticEntries, diagnostics?: readonly FakeDiagnostic[]): void;
}

export interface FakeMarkdownPart {
  text?: string;
  code?: string;
  language?: string;
}

export interface FakeMarkdownString {
  parts: FakeMarkdownPart[];
  appendText(text: string): void;
  appendCodeblock(code: string, language: string): void;
}

export interface FakeHover {
  contents: FakeMarkdownString[];
}

export interface FakeHoverProvider {
  provideHover(document: FakeDocument, position: FakePosition): FakeHover;
}

export interface FakeCommand {
  command: string;
  title?: string;
  arguments: unknown[];
}

export interface FakeEditOperation {
  type: string;
  uri: FakeUri;
  line?: number;
  text?: string;
  options?: { ignoreIfExists: boolean };
}

export interface FakeWorkspaceEdit {
  operations: FakeEditOperation[];
}

export interface FakeCodeAction {
  title: string;
  kind: { value: string };
  command: FakeCommand;
  edit: FakeWorkspaceEdit;
  isPreferred?: boolean;
}

export interface FakeCodeActionProvider {
  /** Fix-all actions are built asynchronously; the other kinds are returned directly. */
  provideCodeActions(
    document: FakeDocument,
    range: FakeRange,
    context: { only: { value: string } },
  ): Promise<FakeCodeAction[]>;
  provideCodeActions(document: FakeDocument, range: FakeRange, context: Record<string, never>): FakeCodeAction[];
}

export interface FakeCodeLens {
  range: FakeRange;
  command: FakeCommand;
}

export interface FakeCodeLensProvider {
  provideCodeLenses(document: FakeDocument): FakeCodeLens[];
}

type FakeDiagnosticsFor = (uri: FakeUri) => Iterable<FakeDiagnostic>;

export interface FakeQuickFixOptions {
  diagnosticsFor(uri: FakeUri): Iterable<FakeDiagnostic>;
  dismissals?: Dismissals;
  onDismissed?(): void;
}

/**
 * The members of the editor module's `vscode` argument; each test fills in the ones its scenario
 * needs.
 */
export interface FakeVscode {
  DiagnosticSeverity: Record<string, number>;
  workspace: { textDocuments: FakeDocument[] };
}

// Each conversion is declared as an overload over an unknown-returning implementation: the fakes
// only approximate the editor types, so the conversion is the one place that states they are
// interchangeable for these tests.
function asEditorApi(fake: FakeVscode): EditorApi;
function asEditorApi(fake: FakeVscode): unknown {
  return fake;
}

function asEditorCollection(fake: FakeDiagnosticCollection): EditorDiagnosticCollection;
function asEditorCollection(fake: FakeDiagnosticCollection): unknown {
  return fake;
}

function asEditorDocument(fake: FakeDocument): EditorDocument;
function asEditorDocument(fake: FakeDocument): unknown {
  return fake;
}

type ExamplesDiagnosticsFor = Parameters<typeof registerExamples>[1];
type QuickFixOptions = Parameters<typeof registerQuickFixes>[1];
type CodeLensDiagnosticsFor = Parameters<typeof registerCodeLenses>[1];

function asExamplesDiagnosticsFor(diagnosticsFor: FakeDiagnosticsFor): ExamplesDiagnosticsFor;
function asExamplesDiagnosticsFor(diagnosticsFor: FakeDiagnosticsFor): unknown {
  return diagnosticsFor;
}

function asQuickFixOptions(options: FakeQuickFixOptions): QuickFixOptions;
function asQuickFixOptions(options: FakeQuickFixOptions): unknown {
  return options;
}

function asCodeLensDiagnosticsFor(diagnosticsFor: FakeDiagnosticsFor): CodeLensDiagnosticsFor;
function asCodeLensDiagnosticsFor(diagnosticsFor: FakeDiagnosticsFor): unknown {
  return diagnosticsFor;
}

type RegisteredProviders = ReturnType<typeof registerExamples>;
type RegisteredQuickFixProviders = ReturnType<typeof registerQuickFixes>;

function asFakeHoverProvider(registered: RegisteredProviders): FakeHoverProvider;
function asFakeHoverProvider(registered: RegisteredProviders): unknown {
  return registered;
}

function asFakeCodeActionProviders(registered: RegisteredQuickFixProviders): FakeCodeActionProvider[];
function asFakeCodeActionProviders(registered: RegisteredQuickFixProviders): unknown {
  return registered;
}

export function publishFake(
  vscode: FakeVscode,
  collection: FakeDiagnosticCollection,
  root: string,
  source: string,
  findings: Finding[],
  options?: PublishOptions,
): void {
  publish(asEditorApi(vscode), asEditorCollection(collection), root, source, findings, options);
}

export function refreshFakeDocument(
  vscode: FakeVscode,
  collection: FakeDiagnosticCollection,
  document: FakeDocument,
): void {
  refreshDocument(asEditorApi(vscode), asEditorCollection(collection), asEditorDocument(document));
}

export function registerFakeExamples(
  vscode: FakeVscode,
  diagnosticsFor: (uri: FakeUri) => Iterable<FakeDiagnostic>,
): FakeHoverProvider {
  const registered = registerExamples(asEditorApi(vscode), asExamplesDiagnosticsFor(diagnosticsFor));
  return asFakeHoverProvider(registered);
}

export function registerFakeQuickFixes(vscode: FakeVscode, options: FakeQuickFixOptions): FakeCodeActionProvider[] {
  const registered = registerQuickFixes(asEditorApi(vscode), asQuickFixOptions(options));
  return asFakeCodeActionProviders(registered);
}

export function registerFakeCodeLenses(
  vscode: FakeVscode,
  diagnosticsFor: (uri: FakeUri) => Iterable<FakeDiagnostic>,
): void {
  registerCodeLenses(asEditorApi(vscode), asCodeLensDiagnosticsFor(diagnosticsFor));
}
