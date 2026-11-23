// Shared shapes for JSDoc type checking (tsconfig.typecheck.json). Types only: nothing here exists at runtime.
import type * as ts from 'typescript';

export type ImpactLevel = 'low' | 'medium' | 'high' | 'critical';
export type Pillar = 'perf' | 'maint' | 'sec';

/** One change of a fix as it appears on a reported finding. */
export interface FixChange {
  file: string;
  line: number;
  before: string;
  after: string;
  create?: boolean;
}

/** `finding.fix` in JSON output. */
export interface FindingFix {
  changes: FixChange[];
  note?: string;
  requiresReview?: boolean;
  comment?: string;
}

export interface Finding {
  file?: string;
  line?: number;
  column?: number;
  ruleId: string;
  message: string;
  /** Before/after estimate for loop rules; the severity is `impactLevel`. */
  impact?: unknown;
  impactLevel?: ImpactLevel;
  contextualReason?: string;
  fix?: FindingFix;
  fixable?: boolean;
  trace?: unknown[];
  hotPath?: { rank: string; reason: string };
  pillar?: Pillar;
  id?: string;
  [detail: string]: unknown;
}

/** An edit in offsets of one file's text. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** One file a builder edits, or creates when `create` is set. */
export interface FileTarget {
  file: string;
  edits?: TextEdit[];
  create?: boolean;
  text?: string;
}

/** What a site-fix builder returns: `edits` for the flagged file, or `targets` for several files. */
export interface FixResult {
  edits?: TextEdit[];
  targets?: FileTarget[];
  note?: string;
  requiresReview?: boolean;
  comment?: string;
  separateEdits?: boolean;
}

export interface LoadedFile {
  filename: string;
  absolute: string;
  text: string;
  lineStarts: number[];
  sourceFile?: ts.SourceFile;
  scriptKind?: number;
}

export interface SiteFixInput {
  finding: Finding;
  node?: ts.Node;
  sourceFile?: ts.SourceFile;
  text?: string;
  load: (filename: string) => LoadedFile | null;
  comments?: boolean;
}

export type SiteFixBuilder = (input: SiteFixInput) => FixResult | undefined;

/** The symbol surface rules use; TypeScript 6 symbols and native adapted symbols both provide it. */
export interface SymbolAdapter {
  name: string;
  flags: number;
  declarations?: readonly ts.Node[];
  valueDeclaration?: ts.Node;
}

/** The type surface rules use. Union members and literal values exist only on some types. */
export interface TypeAdapter {
  flags: number;
  value?: unknown;
  types?: readonly TypeAdapter[];
  isUnion(): boolean;
  isNumberLiteral(): boolean;
  getSymbol(): SymbolAdapter | undefined;
  getProperty(name: string): SymbolAdapter | undefined;
  getCallSignatures(): readonly unknown[];
}

/**
 * The checker surface shared by the TypeScript 6 `ts.TypeChecker` and the native adapter in
 * lib/performance/native-checker.cjs. Optional members exist on only one of them, so callers test for them.
 */
export interface CheckerAdapter {
  getResolvedSignature(node: any): { declaration?: ts.Node } | undefined;
  getTypeAtLocation(node: any): TypeAdapter;
  getReturnTypeOfSignature(signature: any): TypeAdapter;
  getContextualType(node: any): TypeAdapter | undefined;
  getSymbolAtLocation(node: any): SymbolAdapter | undefined;
  resolveName(name: string, location: any, meaning: number, excludeGlobals: boolean): SymbolAdapter | undefined;
  getAliasedSymbol(symbol: any): SymbolAdapter;
  getShorthandAssignmentValueSymbol(property: any): SymbolAdapter | undefined;
  isTypeAssignableTo(source: any, target: any): boolean;
  typeToString(type: any, enclosingDeclaration?: any, flags?: number): string;
  getBaseTypes(type: any): TypeAdapter[];
  getNonNullableType(type: any): TypeAdapter;
  getAwaitedType(type: any): TypeAdapter | undefined;
  isArrayType(type: any): boolean;
  getTypeArguments(type: any): readonly TypeAdapter[];
  /** Native only: whether a file is one of the compiler's default libraries. */
  isDefaultLibrary?(file: any): boolean;
  /** Native only. */
  getAwaitedTypeAtLocation?(node: any): TypeAdapter | undefined;
  /** Native only: one round trip for many nodes. */
  getSymbolsAtLocations?(nodes: readonly any[]): (SymbolAdapter | undefined)[];
}

/** The program surface shared by `ts.Program` and `adaptProgram`. */
export interface ProgramAdapter {
  getTypeChecker(): CheckerAdapter;
  getCompilerOptions(): ts.CompilerOptions;
  /** TypeScript 6 only. */
  getSourceFiles?(): readonly ts.SourceFile[];
  /** Native only. */
  getSourceFileNames?(): readonly string[];
  /** Native only: visits the calls, returns and expressions rules inspect without building other nodes. */
  forEachSourceCandidate?(sourceFile: any, visit: (node: any) => void): void;
  /** Native only: project sources outside node_modules. */
  getToolingSourceFiles?(): readonly any[];
}

export interface RuleContext {
  checker: CheckerAdapter;
  program: ProgramAdapter;
  strictNullChecks: boolean;
  isPackageType(node: ts.Node, packages: readonly string[], typeNames?: readonly string[]): boolean;
  report(
    node: ts.Node,
    ruleId: string,
    message: string,
    contextualReason?: string,
    details?: Record<string, unknown>,
  ): void;
  /** Security rules only. */
  sourceFile?: ts.SourceFile;
  taint?: unknown;
}

export interface SkippedFile {
  file: string;
  reason: string;
}

export interface ScanResult {
  scannedFiles: number;
  findings: Finding[];
  skippedFiles?: SkippedFile[];
  packages?: unknown[];
}

// Drift guards: these fail to type check when the TypeScript 6 API stops matching the shared surface.
type AssertTrue<Condition extends true> = Condition;
export type TypeScriptCheckerMatches = AssertTrue<ts.TypeChecker extends CheckerAdapter ? true : false>;
export type TypeScriptProgramMatches = AssertTrue<ts.Program extends ProgramAdapter ? true : false>;

// TypeScript internals the code relies on deliberately: parse and bind diagnostics to vet a fix's output, the binder
// to build symbols for one file, and the extension helper for synthetic module resolutions. Declared here so a
// TypeScript upgrade that drops one fails the typecheck instead of failing at run time.
declare module 'typescript' {
  interface SourceFile {
    parseDiagnostics?: readonly Diagnostic[];
    bindDiagnostics?: readonly Diagnostic[];
  }
  interface Node {
    symbol?: ts.Symbol;
  }
  function bindSourceFile(file: SourceFile, options: CompilerOptions): void;
  function extensionFromPath(path: string): Extension;
}
