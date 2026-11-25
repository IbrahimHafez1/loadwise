// @ts-check
import { requireNative } from './native-runtime.js';
import { isSourceInput } from './source-inputs.js';
import type { CompilerOptions, Node, SourceFile } from 'typescript';
import type { CheckerAdapter, ProgramAdapter, ResolvedSignature, SymbolAdapter, TypeAdapter } from '../shared/types.js';
import type {
  AdaptedSymbol,
  AdaptedType,
  NativeProgram,
  NativeSignature,
  NativeSourceFile,
  NativeSymbol,
  NativeType,
} from './types/native-typescript.js';
const { SyntaxKind } = requireNative('typescript/ast');
const { NODE_LEN, NODE_OFFSET_KIND, NODE_OFFSET_PARENT, HEADER_OFFSET_NODES } =
  requireNative('./dist/api/node/protocol.js');

// This table belongs to the vendored compiler paired with its exact native binary.
// Its preorder rows let us skip allocating JS nodes for unrelated syntax. The
// SDK accessor builds real parent links and reuses the same node objects as the checker.
const candidateKinds = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.ReturnStatement,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.PrefixUnaryExpression,
]);
const callKinds = new Set([SyntaxKind.CallExpression, SyntaxKind.NewExpression]);

function forEachSourceCandidate(sourceFile: NativeSourceFile, visit: (node: Node) => void): void {
  forEachNodeOfKinds(sourceFile, candidateKinds, visit);
}

function forEachNodeOfKinds(
  sourceFile: NativeSourceFile,
  kinds: ReadonlySet<number>,
  visit: (node: Node) => void,
): void {
  const view = sourceFile.view;
  const table = view.getUint32(HEADER_OFFSET_NODES, true);
  const count = sourceFile.nodes.length;
  let jsDocRoot = 0;
  for (let index = sourceFile.index + 1; index < count; index++) {
    const offset = table + index * NODE_LEN;
    if (jsDocRoot) {
      if (view.getUint32(offset + NODE_OFFSET_PARENT, true) >= jsDocRoot) continue;
      jsDocRoot = 0;
    }
    const kind = view.getUint32(offset + NODE_OFFSET_KIND, true);
    if (kind === SyntaxKind.JSDoc) jsDocRoot = index;
    else if (kinds.has(kind)) visit(sourceFile.getOrCreateNodeAtIndex(index));
  }
}

// The adapter attaches `nativeType` after building the plain-data object, so the assertion carries
// the added member into the type.
function defineNativeType(
  adapted: Omit<AdaptedType, 'nativeType'>,
  nativeType: NativeType,
): asserts adapted is AdaptedType {
  Object.defineProperty(adapted, 'nativeType', { value: nativeType });
}

function isAdaptedType(type: TypeAdapter): type is AdaptedType {
  return 'nativeType' in type;
}

function isAdaptedSymbol(symbol: SymbolAdapter): symbol is AdaptedSymbol {
  return 'resolveAlias' in symbol;
}

function isNativeSourceFile(sourceFile: SourceFile): sourceFile is NativeSourceFile {
  return 'getOrCreateNodeAtIndex' in sourceFile;
}

// One batch is one message to the native process; bounded chunks keep a large file's request size
// in check.
const signatureBatchSize = 1000;

// The native adapter hands rules these in place of TypeScript's own symbols, types and nodes.
function adaptProgram(program: NativeProgram, options: CompilerOptions = {}): ProgramAdapter {
  const native = program.getProject().checker;
  const symbols = new WeakMap<NativeSymbol, AdaptedSymbol>();
  const defaultLibraries = new WeakMap<SourceFile, boolean>();
  let toolingSources: SourceFile[] | undefined;

  function isDefaultLibrary(file: SourceFile): boolean {
    const known = defaultLibraries.get(file);
    if (known !== undefined) return known;
    const isDefault = program.getSourceFileMetadata(file.fileName).isDefaultLibrary;
    defaultLibraries.set(file, isDefault);
    return isDefault;
  }

  // Preserve symbol identity for binding comparisons. Native symbol IDs are
  // scoped by owner, and their declaration handles may refer to another file.
  function adaptSymbol(symbol: NativeSymbol): AdaptedSymbol;
  function adaptSymbol(symbol: NativeSymbol | undefined): AdaptedSymbol | undefined;
  function adaptSymbol(symbol: NativeSymbol | undefined): AdaptedSymbol | undefined {
    if (!symbol) return;
    if (!symbols.has(symbol)) {
      symbols.set(symbol, {
        name: symbol.name,
        getName: () => symbol.name,
        flags: symbol.flags,
        resolveAlias: () => adaptSymbol(native.getAliasedSymbol(symbol)),
        get declarations() {
          return symbol.declarations.map((handle) => handle.resolve());
        },
        get valueDeclaration() {
          return symbol.valueDeclaration?.resolve();
        },
      });
    }
    return symbols.get(symbol);
  }

  function adaptType(type: NativeType): AdaptedType {
    const adapted: Omit<AdaptedType, 'nativeType'> = {
      flags: type.flags,
      value: type.value,
      isUnion: () => type.isUnionType(),
      isNumberLiteral: () => type.isNumberLiteralType(),
      isStringLiteral: () => type.isStringLiteralType(),
      isIntersection: () => type.isIntersectionType(),
      isClassOrInterface: () => type.isClassOrInterface(),
      objectFlags: type.objectFlags,
      get target() {
        const target = type.getTarget();
        return target && adaptType(target);
      },
      get aliasSymbol() {
        return adaptSymbol(type.getAliasSymbol());
      },
      getProperties: () => type.getProperties().map(adaptSymbol),
      isUnionOrIntersection: () => type.isUnionType() || type.isIntersectionType(),
      get types() {
        return type.getTypes().map(adaptType);
      },
      getSymbol: () => adaptSymbol(type.getSymbol()),
      getProperty: (name: string) => adaptSymbol(type.getProperty(name)),
      // Signatures stay native objects; rules only hand them back to getReturnTypeOfSignature.
      getCallSignatures: () => type.getCallSignatures(),
    };
    // Kept out of enumeration so adapted types still look like plain data; type relation queries
    // need the original.
    defineNativeType(adapted, type);
    return adapted;
  }

  // Rules ask about the same nodes repeatedly; each answer is a synchronous IPC round trip and
  // stays valid for the lifetime of the program snapshot.
  function cachedByNode<Answer>(query: (node: Node) => Answer): (node: Node) => Answer {
    const answers = new WeakMap<Node, { answer: Answer }>();
    return (node: Node) => {
      const cached = answers.get(node);
      if (cached) return cached.answer;
      const computed = { answer: query(node) };
      answers.set(node, computed);
      return computed.answer;
    };
  }

  // Types the adapter handed out carry their native type; the shared surface only promises
  // `TypeAdapter`.
  function nativeTypeOf(type: TypeAdapter): NativeType {
    if (!isAdaptedType(type)) throw new Error('Expected a type adapted by the native checker.');
    return type.nativeType;
  }

  function adaptSignature(signature: NativeSignature | undefined): ResolvedSignature | undefined {
    return signature && { declaration: signature.declaration?.resolve() };
  }

  // Rules resolve nearly every call in a file, so the first request for a file resolves all of its
  // calls in one batched round trip.
  const signatures = new WeakMap<Node, ResolvedSignature | undefined>();
  const resolvedFiles = new WeakSet<SourceFile>();
  function resolveFileCalls(sourceFile: NativeSourceFile): void {
    resolvedFiles.add(sourceFile);
    const calls: Node[] = [];
    forEachNodeOfKinds(sourceFile, callKinds, (call) => {
      if (!signatures.has(call)) calls.push(call);
    });
    if (!calls.length) return;
    for (let offset = 0; offset < calls.length; offset += signatureBatchSize) {
      const slice = calls.slice(offset, offset + signatureBatchSize);
      const resolved = native.project.api.batch(...slice.map((call) => native.getResolvedSignature.gen(call)));
      slice.forEach((call, index) => signatures.set(call, adaptSignature(resolved[index])));
    }
  }

  const checker: CheckerAdapter = {
    isDefaultLibrary,
    getResolvedSignature(node: Node) {
      if (!signatures.has(node)) {
        const sourceFile = node.getSourceFile();
        if (callKinds.has(node.kind) && !resolvedFiles.has(sourceFile) && isNativeSourceFile(sourceFile))
          resolveFileCalls(sourceFile);
        if (!signatures.has(node)) signatures.set(node, adaptSignature(native.getResolvedSignature(node)));
      }
      return signatures.get(node);
    },
    getTypeAtLocation: cachedByNode((node: Node) => adaptType(native.getTypeAtLocation(node))),
    getReturnTypeOfSignature: (signature) => adaptType(native.getReturnTypeOfSignature(signature)),
    getAwaitedTypeAtLocation(node: Node) {
      const type = native.getAwaitedType(native.getTypeAtLocation(node));
      return type && adaptType(type);
    },
    getContextualType(node: Node) {
      const type = native.getContextualType(node);
      return type && adaptType(type);
    },
    getSymbolAtLocation: cachedByNode((node: Node) => adaptSymbol(native.getSymbolAtLocation(node))),
    resolveName: (name, node, meaning, excludeGlobals) =>
      adaptSymbol(native.resolveName(name, meaning, node, excludeGlobals)),
    getBaseTypes: (type) => native.getBaseTypes(nativeTypeOf(type)).map(adaptType),
    getNonNullableType: (type) => adaptType(native.getNonNullableType(nativeTypeOf(type))),
    getAwaitedType(type) {
      const awaited = native.getAwaitedType(nativeTypeOf(type));
      return awaited && adaptType(awaited);
    },
    isArrayType: (type) => native.isArrayType(nativeTypeOf(type)),
    // TypeScript 6 names the value type `type`; the native API calls it `valueType`.
    getIndexInfosOfType: (type) =>
      native.getIndexInfosOfType(nativeTypeOf(type)).map((info) => ({
        keyType: adaptType(info.keyType),
        type: adaptType(info.valueType),
        isReadonly: info.isReadonly,
        declaration: info.declaration?.resolve(),
      })),
    getTypeArguments: (type) => native.getTypeArguments(nativeTypeOf(type)).map(adaptType),
    getAliasedSymbol: (symbol) => {
      if (!isAdaptedSymbol(symbol)) throw new Error('Expected a symbol adapted by the native checker.');
      return symbol.resolveAlias();
    },
    getSymbolsAtLocations: (nodes) => native.getSymbolAtLocation(nodes).map(adaptSymbol),
    getShorthandAssignmentValueSymbol: (property) => adaptSymbol(native.getShorthandAssignmentValueSymbol(property)),
    isTypeAssignableTo: (source, target) => native.isTypeAssignableTo(nativeTypeOf(source), nativeTypeOf(target)),
    typeToString: (type, enclosingDeclaration, flags) =>
      native.typeToString(nativeTypeOf(type), enclosingDeclaration, flags),
  };
  return {
    getTypeChecker: () => checker,
    getCompilerOptions: () => options,
    getSourceFileNames: () => program.getSourceFileNames(),
    forEachSourceCandidate,
    getToolingSourceFiles() {
      toolingSources ??= program
        .getSourceFileNames()
        .filter((filename: string) => isSourceInput(filename) && !/[\\/]node_modules[\\/]/i.test(filename))
        .flatMap((filename: string) => program.getSourceFile(filename) ?? []);
      return toolingSources;
    },
  };
}

export { adaptProgram, forEachSourceCandidate };
