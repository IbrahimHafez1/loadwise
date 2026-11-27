// Shared shapes used across the checkers. Types only: nothing here exists at runtime, so import it
// with `import type`.
import type * as ts from 'typescript';
import type { PillarName } from './types/pillar-name.js';

export type ImpactLevel = 'low' | 'medium' | 'high' | 'critical';
export type Pillar = 'perf' | 'rel' | 'maint' | 'sec' | 'a11y';

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

/** Before/after estimate attached to loop findings. */
export interface LoopImpact {
  kind: 'estimated' | 'measured';
  before: string | number;
  after: string | number;
  unit: string;
  method: string;
  measured?: readonly string[];
}

export interface HotPath {
  rank: string;
  reason: string;
}

export interface Finding {
  file?: string;
  line?: number;
  column?: number;
  ruleId: string;
  message: string;
  /** Before/after estimate for loop rules; the severity is `impactLevel`. */
  impact?: LoopImpact;
  impactLevel?: ImpactLevel;
  contextualReason?: string;
  fix?: FindingFix;
  fixable?: boolean;
  trace?: TraceStep[];
  hotPath?: HotPath;
  /** The analyzer that produced the finding, set when several analyzers ran in one pass. */
  pillar?: PillarName;
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

/**
 * What a site-fix builder returns: `edits` for the flagged file, or `targets` for several files.
 */
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

/**
 * The symbol surface rules use; TypeScript 6 symbols and native adapted symbols both provide it.
 */
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
  getCallSignatures(): readonly SignatureAdapter[];
  /** The alias a type was declared through (`type Handler = ...`). */
  aliasSymbol?: SymbolAdapter;
}

/** A call signature; the native adapter lazily resolves its declaration. */
export interface SignatureAdapter {
  declaration?: ts.Node | { resolve(): ts.Node | undefined };
  getDeclaration?(): ts.Node | undefined;
}

/** What `getResolvedSignature` yields: the declaration the call resolves to, when there is one. */
export interface ResolvedSignature {
  declaration?: ts.Node;
}

/**
 * The checker surface shared by the TypeScript 6 `ts.TypeChecker` and the native adapter in
 * lib/performance/native-checker.cjs. Optional members exist on only one of them, so callers test
 * for them.
 */
export interface CheckerAdapter {
  getResolvedSignature(node: ts.Node): ResolvedSignature | undefined;
  getTypeAtLocation(node: ts.Node): TypeAdapter;
  getReturnTypeOfSignature(signature: SignatureAdapter): TypeAdapter;
  getContextualType(node: ts.Expression): TypeAdapter | undefined;
  getSymbolAtLocation(node: ts.Node): SymbolAdapter | undefined;
  resolveName(
    name: string,
    location: ts.Node | undefined,
    meaning: number,
    excludeGlobals: boolean,
  ): SymbolAdapter | undefined;
  getAliasedSymbol(symbol: SymbolAdapter): SymbolAdapter;
  getShorthandAssignmentValueSymbol(property: ts.Node | undefined): SymbolAdapter | undefined;
  isTypeAssignableTo(source: TypeAdapter, target: TypeAdapter): boolean;
  typeToString(type: TypeAdapter, enclosingDeclaration?: ts.Node, flags?: number): string;
  getBaseTypes(type: TypeAdapter): TypeAdapter[];
  getNonNullableType(type: TypeAdapter): TypeAdapter;
  getAwaitedType(type: TypeAdapter): TypeAdapter | undefined;
  isArrayType(type: TypeAdapter): boolean;
  getTypeArguments(type: TypeAdapter): readonly TypeAdapter[];
  getIndexInfosOfType(type: TypeAdapter): readonly { keyType: TypeAdapter; type: TypeAdapter; isReadonly: boolean }[];
  /** Native only: whether a file is one of the compiler's default libraries. */
  isDefaultLibrary?(file: ts.SourceFile): boolean;
  /** Native only. */
  getAwaitedTypeAtLocation?(node: ts.Node): TypeAdapter | undefined;
  /** Native only: one round trip for many nodes. */
  getSymbolsAtLocations?(nodes: readonly ts.Node[]): (SymbolAdapter | undefined)[];
}

/** The program surface shared by `ts.Program` and `adaptProgram`. */
export interface ProgramAdapter {
  getTypeChecker(): CheckerAdapter;
  getCompilerOptions(): ts.CompilerOptions;
  /** TypeScript 6 only. */
  getSourceFiles?(): readonly ts.SourceFile[];
  /** Native only. */
  getSourceFileNames?(): readonly string[];
  /**
   * Native only: visits the calls, returns and expressions rules inspect without building other
   * nodes.
   */
  forEachSourceCandidate?(sourceFile: ts.SourceFile, visit: (node: ts.Node) => void): void;
  /** Native only: project sources outside node_modules. */
  getToolingSourceFiles?(): readonly ts.SourceFile[];
}

/**
 * Extra data a rule attaches to a finding: `taint` becomes `finding.trace`; the rest is copied onto
 * the finding.
 */
export interface ReportDetails {
  taint?: Trace;
  suggestion?: string;
  [detail: string]: unknown;
}

type ReportFinding = (
  node: ts.Node,
  ruleId: string,
  message: string,
  contextualReason?: string,
  details?: ReportDetails,
) => void;

/** The members every rule context has, whichever checker built it. */
export interface RuleContext {
  checker: CheckerAdapter;
  program: ProgramAdapter;
  strictNullChecks: boolean;
  isPackageType(node: ts.Node, packages: readonly string[], typeNames?: readonly string[]): boolean;
  report: ReportFinding;
  policy?: RulePolicy;
  /** Security rules only; see SecurityRuleContext. */
  sourceFile?: ts.SourceFile;
  /** Security rules only; see SecurityRuleContext. */
  taint?: TaintApi;
}

/** The project policy rules read; each checker uses the members it knows. */
export interface RulePolicy {
  fireAndForget?: readonly string[];
  parallelReads?: unknown;
  prismaScopes?: Readonly<Record<string, ScopePolicy>>;
  drizzleScopes?: Readonly<Record<string, ScopePolicy>>;
  [setting: string]: unknown;
}

/** One model or table whose queries must stay inside an authorization scope. */
export interface ScopePolicy {
  field: string;
  [setting: string]: unknown;
}

/** What the performance analyzer hands each rule. */
export interface PerformanceRuleContext extends RuleContext {
  verbatimModuleSyntax: boolean;
  fireAndForgetNames: ReadonlySet<string>;
  isRepeated(node: ts.Node): boolean;
}

/** What the security analyzer hands each rule. */
export interface SecurityRuleContext extends RuleContext {
  sourceFile: ts.SourceFile;
  fileContext: FileContext;
  taint: TaintApi;
  /** Cached per call: the library a call belongs to. */
  libraryCall(call: ts.CallExpression | ts.NewExpression): LibraryCall | undefined;
}

/** Facts about the file under analysis. */
export interface FileContext {
  isTestSource: boolean;
  testSourceReason: string | undefined;
  underNonProductionGuard(node: ts.Node): boolean;
}

/**
 * How a call was tied to a library: by import, by declaring type, or by a distinctive method name
 * alone.
 */
type LibraryCallTier = 'import' | 'type' | 'name';

/**
 * `exec` in `import { exec } from 'child_process'`; `exported` is a name, 'default', or '*' for a
 * namespace.
 */
export interface ModuleBinding {
  module: string;
  exported: string | undefined;
}

export interface LibraryCall {
  module: string | undefined;
  exported: string | undefined;
  /** The called property name; undefined when the export itself is called. */
  method: string | undefined;
  tier: LibraryCallTier;
}

export type SinkKind =
  | 'sql'
  | 'nosql'
  | 'shell'
  | 'code'
  | 'regex'
  | 'url'
  | 'redirect'
  | 'path'
  | 'archive-path'
  | 'html'
  | 'proto-key'
  | 'mass-assignment'
  | 'template';

/** One hop of a trace from the source to the sink. */
export interface TraceStep {
  file: string;
  line: number;
  text: string;
}

type TraceShape = 'string' | 'object' | 'unknown';

/** A sink argument that traces back to request data. */
export interface Trace {
  label: string;
  sourceNode: ts.Node;
  sourceKind: string;
  hops: number;
  /** The whole client-controlled object, not one scalar field of it. */
  whole: boolean;
  shape: TraceShape;
  steps: TraceStep[];
}

type TaintKind = 'whole' | 'scalar';

/** A request object whose listed fields, element and method results are client data. */
export interface TaintContainer {
  fields?: Readonly<Record<string, TaintField>>;
  element?: TaintField;
  calls?: Readonly<Record<string, TaintField>>;
}

/** A field or call result of a request container: tainted, or another container. */
export interface TaintField extends TaintContainer {
  taint?: TaintKind;
}

/** Where a handler parameter's data comes from. */
export interface ParameterSource {
  label: string;
  taint?: TaintKind;
  container?: TaintContainer;
}

/** The shape a validation schema admits. */
export interface SchemaShape {
  kind: string;
  fields?: ReadonlyMap<string, ts.Node>;
}

/** The function whose parameter a return summary treats as the only tainted value. */
interface SummaryState {
  fn: ts.SignatureDeclaration;
  index: number;
}

export interface TaintState {
  sinkKind: SinkKind;
  hops: number;
  summary?: SummaryState;
}

/** The internal result of resolving an expression, before it becomes a public Trace. */
export interface TaintResult {
  taint?: TaintKind;
  label?: string;
  sourceNode?: ts.Node;
  sourceKind?: string;
  hops: number;
  steps: TraceStep[];
  container?: TaintContainer;
  /** The symbolic parameter index of a return summary. */
  parameter?: number;
  objectFields?: Map<string, TaintResult>;
  objectSteps?: number;
  dto?: ts.ParameterDeclaration;
  schema?: SchemaShape;
  wrapper?: string;
}

/** The part of a URL a client controls. */
export interface UrlControl {
  part: string;
  trace: Trace;
  rawPathname?: boolean;
}

/** The functions rule groups use to ask whether a sink argument traces to request data. */
export interface TaintApi {
  trace(expression: ts.Expression, sinkKind: SinkKind): Trace | undefined;
  isUntracedParameter(expression: ts.Expression): boolean;
  urlControl(expression: ts.Expression): UrlControl | undefined;
}

/** Validation a project helper applies to one parameter. */
export interface ArgumentValidation {
  parameterIndex: number;
  kind: string;
  mode: string;
}

/** Return-flow and call-site summaries of project-local functions. */
export interface TaintSummaries {
  returnSummary(
    fn: ts.SignatureDeclaration,
    sinkKind: SinkKind,
    flows: (expression: ts.Expression, parameterIndex: number) => boolean,
  ): number[];
  callSites(fn: ts.SignatureDeclaration): ts.CallExpression[];
  localCallee(call: ts.CallExpression): ts.SignatureDeclaration | undefined;
}

export interface SkippedFile {
  file: string;
  reason: string;
}

/** A monorepo package whose files are reported together. */
export interface PackageScope {
  name: string;
  directory: string;
}

export interface ScanResult {
  scannedFiles: number;
  findings: Finding[];
  skippedFiles?: SkippedFile[];
  packages?: PackageScope[];
}

// Drift guards: these fail to type check when the TypeScript 6 API stops matching the shared
// surface.
type AssertTrue<Condition extends true> = Condition;
export type TypeScriptCheckerMatches = AssertTrue<ts.TypeChecker extends CheckerAdapter ? true : false>;
export type TypeScriptProgramMatches = AssertTrue<ts.Program extends ProgramAdapter ? true : false>;

// TypeScript internals the code relies on deliberately: parse and bind diagnostics to vet a fix's
// output, the binder to build symbols for one file, and the extension helper for synthetic module
// resolutions. Declared here so a TypeScript upgrade that drops one fails the typecheck instead of
// failing at run time.
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
