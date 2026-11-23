// @ts-check
'use strict';

const { requireNative } = require('./native-runtime.cjs');
const { isSourceInput } = require('./source-inputs.cjs');
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

function forEachSourceCandidate(sourceFile, visit) {
  forEachNodeOfKinds(sourceFile, candidateKinds, visit);
}

function forEachNodeOfKinds(sourceFile, kinds, visit) {
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

// One batch is one message to the native process; bounded chunks keep a large file's request size in check.
const signatureBatchSize = 1000;

/** @returns {import('../shared/types').ProgramAdapter} */
function adaptProgram(program, options = {}) {
  const native = program.getProject().checker;
  const symbols = new WeakMap();
  const defaultLibraries = new WeakMap();
  let toolingSources;

  function isDefaultLibrary(file) {
    if (!defaultLibraries.has(file)) {
      defaultLibraries.set(file, program.getSourceFileMetadata(file.fileName).isDefaultLibrary);
    }
    return defaultLibraries.get(file);
  }

  // Preserve symbol identity for binding comparisons. Native symbol IDs are
  // scoped by owner, and their declaration handles may refer to another file.
  function adaptSymbol(symbol) {
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

  function adaptType(type) {
    const adapted = {
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
      getProperty: (name) => adaptSymbol(type.getProperty(name)),
      // Signatures stay native objects; rules only hand them back to getReturnTypeOfSignature.
      getCallSignatures: () => type.getCallSignatures(),
    };
    // Kept out of enumeration so adapted types still look like plain data; type relation queries need the original.
    Object.defineProperty(adapted, 'nativeType', { value: type });
    return adapted;
  }

  // Rules ask about the same nodes repeatedly; each answer is a synchronous IPC round trip and stays
  // valid for the lifetime of the program snapshot.
  function cachedByNode(query) {
    const answers = new WeakMap();
    return (node) => {
      if (!answers.has(node)) answers.set(node, query(node));
      return answers.get(node);
    };
  }

  function adaptSignature(signature) {
    return signature && { declaration: signature.declaration?.resolve() };
  }

  // Rules resolve nearly every call in a file, so the first request for a file resolves all of its
  // calls in one batched round trip.
  const signatures = new WeakMap();
  const resolvedFiles = new WeakSet();
  function resolveFileCalls(sourceFile) {
    resolvedFiles.add(sourceFile);
    const calls = [];
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

  /** @type {import('../shared/types').CheckerAdapter} */
  const checker = {
    isDefaultLibrary,
    getResolvedSignature(node) {
      if (!signatures.has(node)) {
        const sourceFile = node.getSourceFile();
        if (callKinds.has(node.kind) && !resolvedFiles.has(sourceFile)) resolveFileCalls(sourceFile);
        if (!signatures.has(node)) signatures.set(node, adaptSignature(native.getResolvedSignature(node)));
      }
      return signatures.get(node);
    },
    getTypeAtLocation: cachedByNode((node) => adaptType(native.getTypeAtLocation(node))),
    getReturnTypeOfSignature: (signature) => adaptType(native.getReturnTypeOfSignature(signature)),
    getAwaitedTypeAtLocation(node) {
      const type = native.getAwaitedType(native.getTypeAtLocation(node));
      return type && adaptType(type);
    },
    getContextualType(node) {
      const type = native.getContextualType(node);
      return type && adaptType(type);
    },
    getSymbolAtLocation: cachedByNode((node) => adaptSymbol(native.getSymbolAtLocation(node))),
    resolveName: (name, node, meaning, excludeGlobals) =>
      adaptSymbol(native.resolveName(name, meaning, node, excludeGlobals)),
    getBaseTypes: (type) => native.getBaseTypes(type.nativeType).map(adaptType),
    getNonNullableType: (type) => adaptType(native.getNonNullableType(type.nativeType)),
    getAwaitedType(type) {
      const awaited = native.getAwaitedType(type.nativeType);
      return awaited && adaptType(awaited);
    },
    isArrayType: (type) => native.isArrayType(type.nativeType),
    // TypeScript 6 names the value type `type`; the native API calls it `valueType`.
    getIndexInfosOfType: (type) =>
      native.getIndexInfosOfType(type.nativeType).map((info) => ({
        keyType: adaptType(info.keyType),
        type: adaptType(info.valueType),
        isReadonly: info.isReadonly,
        declaration: info.declaration?.resolve(),
      })),
    getTypeArguments: (type) => native.getTypeArguments(type.nativeType).map(adaptType),
    getAliasedSymbol: (symbol) => symbol.resolveAlias(),
    getSymbolsAtLocations: (nodes) => native.getSymbolAtLocation(nodes).map(adaptSymbol),
    getShorthandAssignmentValueSymbol: (property) => adaptSymbol(native.getShorthandAssignmentValueSymbol(property)),
    isTypeAssignableTo: (source, target) => native.isTypeAssignableTo(source.nativeType, target.nativeType),
    typeToString: (type, enclosingDeclaration, flags) =>
      native.typeToString(type.nativeType, enclosingDeclaration, flags),
  };
  return {
    getTypeChecker: () => checker,
    getCompilerOptions: () => options,
    getSourceFileNames: () => program.getSourceFileNames(),
    forEachSourceCandidate,
    getToolingSourceFiles() {
      toolingSources ??= program
        .getSourceFileNames()
        .filter((filename) => isSourceInput(filename) && !/[\\/]node_modules[\\/]/i.test(filename))
        .map((filename) => program.getSourceFile(filename));
      return toolingSources;
    },
  };
}

module.exports = { adaptProgram, forEachSourceCandidate };
