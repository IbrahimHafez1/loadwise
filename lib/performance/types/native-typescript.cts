// The parts of the vendored native TypeScript SDK (`typescript/sync`, `typescript/ast`) that
// loadwise uses. The SDK ships without declarations, so this describes only what the --native
// engine reads. Its syntax nodes follow the TypeScript node shapes, so they are typed with the
// `typescript` package's node types.
import type * as TypeScript from 'typescript';
import type { CompilerOptions, Node, SourceFile } from 'typescript';
import type { SignatureAdapter, SymbolAdapter, TypeAdapter } from '../../shared/types.cjs';

/** A declaration the native process refers to by id until it is resolved to a node. */
export interface NativeHandle {
  resolve(): Node;
}

export interface NativeSymbol {
  name: string;
  flags: number;
  declarations: readonly NativeHandle[];
  valueDeclaration?: NativeHandle;
}

/** A call signature; rules only hand these back to the checker. */
export interface NativeSignature extends SignatureAdapter {
  declaration?: NativeHandle;
}

export interface NativeType {
  flags: number;
  value?: unknown;
  objectFlags: number;
  isUnionType(): boolean;
  isIntersectionType(): boolean;
  isNumberLiteralType(): boolean;
  isStringLiteralType(): boolean;
  isClassOrInterface(): boolean;
  getTarget(): NativeType | undefined;
  getAliasSymbol(): NativeSymbol | undefined;
  getProperties(): NativeSymbol[];
  getProperty(name: string): NativeSymbol | undefined;
  getTypes(): NativeType[];
  getSymbol(): NativeSymbol | undefined;
  getCallSignatures(): NativeSignature[];
}

export interface NativeIndexInfo {
  keyType: NativeType;
  valueType: NativeType;
  isReadonly: boolean;
  declaration?: NativeHandle;
}

/** A queued checker call, answered together with others by one `batch`. */
export type NativeRequest = Readonly<Record<string, unknown>>;

export interface NativeChecker {
  project: { api: { batch(...requests: NativeRequest[]): (NativeSignature | undefined)[] } };
  getResolvedSignature: {
    (node: Node): NativeSignature | undefined;
    gen(node: Node): NativeRequest;
  };
  getTypeAtLocation(node: Node): NativeType;
  /** Takes the signature objects `getCallSignatures` returned. */
  getReturnTypeOfSignature(signature: SignatureAdapter): NativeType;
  getAwaitedType(type: NativeType): NativeType | undefined;
  getContextualType(node: Node): NativeType | undefined;
  getSymbolAtLocation(node: Node): NativeSymbol | undefined;
  getSymbolAtLocation(nodes: readonly Node[]): (NativeSymbol | undefined)[];
  getAliasedSymbol(symbol: NativeSymbol): NativeSymbol;
  resolveName(
    name: string,
    meaning: number,
    location: Node | undefined,
    excludeGlobals: boolean,
  ): NativeSymbol | undefined;
  getBaseTypes(type: NativeType): NativeType[];
  getNonNullableType(type: NativeType): NativeType;
  isArrayType(type: NativeType): boolean;
  getIndexInfosOfType(type: NativeType): NativeIndexInfo[];
  getTypeArguments(type: NativeType): NativeType[];
  getShorthandAssignmentValueSymbol(property: Node | undefined): NativeSymbol | undefined;
  isTypeAssignableTo(source: NativeType, target: NativeType): boolean;
  typeToString(type: NativeType, enclosingDeclaration?: Node, flags?: number): string;
}

/** A source file as the native SDK reads it: the node table lives in a binary view. */
export interface NativeSourceFile extends SourceFile {
  view: DataView;
  nodes: readonly unknown[];
  index: number;
  getOrCreateNodeAtIndex(index: number): Node;
}

/** A syntax node of the native SDK, which walks its own children. */
export interface NativeNode extends Node {
  forEachChild<Result>(visit: (child: Node) => Result | undefined): Result | undefined;
}

export interface NativeDiagnostic {
  code: number;
  text: string;
  fileName: string;
  startPosition: { line: number; character: number };
}

export interface NativeProgram {
  getProject(): { checker: NativeChecker };
  getSourceFileMetadata(fileName: string): { isDefaultLibrary: boolean };
  getSourceFileNames(): string[];
  getSourceFile(fileName: string): NativeSourceFile | undefined;
  getProgramDiagnostics(): NativeDiagnostic[];
  getSyntacticDiagnostics(fileNames: readonly string[]): NativeDiagnostic[];
  dispose(): void;
}

export interface NativeConfig {
  errors?: NativeDiagnostic[];
  options: CompilerOptions;
  projectReferences?: { path: string }[];
  fileNames: string[];
}

/** A virtual file system the native process reads instead of the disk. */
export interface NativeFileSystem {
  readonly kind?: never;
}

/** The programs one snapshot is asked to create. */
export interface NativeSnapshotRequest {
  fileSystem: NativeFileSystem;
  createPrograms: readonly { rootFiles: readonly string[]; compilerOptions: CompilerOptions }[];
}

export interface NativeSnapshot {
  operation: { createdPrograms: NativeProgram[] };
  dispose(): void;
}

/** A source file the native process keeps alive until disposed. */
export interface NativeRetainedSourceFile {
  sourceFile: NativeSourceFile;
  dispose(): void;
}

export interface NativeApi {
  createSnapshot(request: NativeSnapshotRequest): NativeSnapshot;
  createSourceFile(fileName: string, contents: string): NativeRetainedSourceFile;
  getCanonicalFileName(fileName: string): string;
  createProgram(roots: readonly string[], options: CompilerOptions): NativeProgram;
  parseConfigFile(fileName: string): NativeConfig;
  close(): void;
}

type TypeScriptModule = typeof TypeScript;

/** `typescript/sync`: the API entry point and the option enums. */
export interface NativeBinding extends Pick<TypeScriptModule, 'ModuleKind' | 'ModuleResolutionKind' | 'JsxEmit'> {
  API: new (options?: { tsserverPath: string }) => NativeApi;
  formatDiagnostics(diagnostics: readonly NativeDiagnostic[], api: NativeApi): string;
}

/** `typescript/fs`: the in-memory file system with the default library. */
export interface NativeFileSystemModule {
  createFileSystemWithLib(entries: readonly (readonly string[])[]): NativeFileSystem;
}

/** `typescript/sync` as native-syntax.cjs reads it: the flag enums. */
export type NativeFlags = Pick<TypeScriptModule, 'ModifierFlags' | 'ObjectFlags' | 'SymbolFlags' | 'TypeFlags'>;

/** `typescript/ast`: the node kind and flag enums. */
export type NativeAst = Pick<TypeScriptModule, 'SyntaxKind' | 'NodeFlags' | 'ScriptTarget'>;

/**
 * `typescript/ast/is`: the node guards; the native SDK names some of them differently from
 * TypeScript.
 */
export type NativeGuards = Pick<
  TypeScriptModule,
  | 'isBinaryExpression'
  | 'isPrefixUnaryExpression'
  | 'isPostfixUnaryExpression'
  | 'isForInStatement'
  | 'isForOfStatement'
  | 'isSpreadAssignment'
  | 'isPropertyAssignment'
  | 'isShorthandPropertyAssignment'
  | 'isParenthesizedExpression'
  | 'isArrayLiteralExpression'
  | 'isNonNullExpression'
  | 'isSpreadElement'
  | 'isDecorator'
  | 'isPropertyDeclaration'
  | 'isMethodDeclaration'
  | 'isCaseClause'
  | 'isDefaultClause'
  | 'isGetAccessorDeclaration'
  | 'isSetAccessorDeclaration'
  | 'isClassDeclaration'
  | 'isClassExpression'
> & {
  isAssignmentOperator(kind: TypeScript.SyntaxKind): boolean;
  isParameterDeclaration: TypeScriptModule['isParameter'];
  isMethodSignatureDeclaration: TypeScriptModule['isMethodSignature'];
  isFunctionLikeDeclaration: TypeScriptModule['isFunctionLike'];
  isClassLikeDeclaration: TypeScriptModule['isClassLike'];
  isStringLiteralLikeNode: TypeScriptModule['isStringLiteralLike'];
  isTypeAssertion: TypeScriptModule['isTypeAssertionExpression'];
  isPropertySignatureDeclaration: TypeScriptModule['isPropertySignature'];
};

/** `typescript/ast/utils`. */
export interface NativeAstUtils {
  getCombinedModifierFlags: TypeScriptModule['getCombinedModifierFlags'];
}

/** The byte layout of the native node table (`dist/api/node/protocol.js`). */
export interface NativeProtocol {
  NODE_LEN: number;
  NODE_OFFSET_KIND: number;
  NODE_OFFSET_PARENT: number;
  HEADER_OFFSET_NODES: number;
}

/** The members of an adapted symbol beyond the shared `SymbolAdapter`. */
export interface AdaptedSymbol extends SymbolAdapter {
  getName(): string;
  resolveAlias(): AdaptedSymbol;
}

/**
 * The members of an adapted type beyond the shared `TypeAdapter`; `nativeType` is not enumerable.
 */
export interface AdaptedType extends TypeAdapter {
  readonly nativeType: NativeType;
  objectFlags: number;
  readonly target: AdaptedType | undefined;
  isStringLiteral(): boolean;
  isIntersection(): boolean;
  isClassOrInterface(): boolean;
  isUnionOrIntersection(): boolean;
  getProperties(): (AdaptedSymbol | undefined)[];
}
