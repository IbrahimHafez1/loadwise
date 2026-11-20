'use strict';

const { requireNative } = require('./native-runtime.cjs');
const { SyntaxKind } = requireNative('typescript/ast');
const { NODE_LEN, NODE_OFFSET_KIND, NODE_OFFSET_PARENT, HEADER_OFFSET_NODES } =
  requireNative('./dist/api/node/protocol.js');

// This table belongs to the vendored compiler paired with its exact native binary.
// Its preorder rows let us skip allocating JS nodes for unrelated syntax. The
// SDK accessor builds real parent links and reuses the same node objects as the checker.
function forEachSourceCandidate(sourceFile, visit) {
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
    else if (
      kind === SyntaxKind.CallExpression ||
      kind === SyntaxKind.NewExpression ||
      kind === SyntaxKind.TaggedTemplateExpression ||
      kind === SyntaxKind.BinaryExpression
    ) {
      visit(sourceFile.getOrCreateNodeAtIndex(index));
    }
  }
}

function adaptProgram(program, options = {}) {
  const native = program.getProject().checker;
  const symbols = new WeakMap();
  const defaultLibraries = new WeakMap();

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
    return {
      flags: type.flags,
      isUnion: () => type.isUnionType(),
      get types() {
        return type.getTypes().map(adaptType);
      },
      getSymbol: () => adaptSymbol(type.getSymbol()),
      getProperty: (name) => adaptSymbol(type.getProperty(name)),
    };
  }

  const checker = {
    isDefaultLibrary,
    getResolvedSignature(node) {
      const signature = native.getResolvedSignature(node);
      return signature && { declaration: signature.declaration?.resolve() };
    },
    getTypeAtLocation: (node) => adaptType(native.getTypeAtLocation(node)),
    getContextualType(node) {
      const type = native.getContextualType(node);
      return type && adaptType(type);
    },
    getSymbolAtLocation: (node) => adaptSymbol(native.getSymbolAtLocation(node)),
    getAliasedSymbol: (symbol) => symbol.resolveAlias(),
    getSymbolsAtLocations: (nodes) => native.getSymbolAtLocation(nodes).map(adaptSymbol),
    getShorthandAssignmentValueSymbol: (property) => adaptSymbol(native.getShorthandAssignmentValueSymbol(property)),
  };
  return { getTypeChecker: () => checker, getCompilerOptions: () => options, forEachSourceCandidate };
}

module.exports = { adaptProgram, forEachSourceCandidate };
