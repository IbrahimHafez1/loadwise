'use strict';

const { syntax: ts } = require('../../performance/compiler.cjs');
const { declaredTypeImport, importedFrom, libraryCall } = require('../bindings.cjs');

const archiveFields = new Map([
  ['adm-zip', 'entryName'],
  ['yauzl', 'fileName'],
  ['yauzl-promise', 'fileName'],
  ['unzipper', 'path'],
  ['tar-stream', 'name'],
  ['jszip', 'name'],
  ['node-stream-zip', 'name'],
]);
const scalar = { taint: 'scalar' };
const entryCollections = new Set(['getEntries', 'entries']);
const entryEvents = new Set(['on', 'once']);
const maxAliasDepth = 6;

function unwrapped(expression) {
  const node = expression && ts.skipOuterExpressions(expression);
  return node && ts.isAwaitExpression(node) ? unwrapped(node.expression) : node;
}

function constValue(node, checker) {
  if (!ts.isIdentifier(node)) return;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const) {
    return declaration.initializer;
  }
}

function callbackOf(parameter) {
  const fn = parameter.parent;
  const call = fn.parent;
  if (ts.isCallExpression(call) && call.arguments.includes(fn)) {
    return { call, index: fn.parameters.indexOf(parameter) };
  }
}

// Recover the module from an imported instance, an annotated receiver, or a local const chain.
function archiveModule(expression, checker, depth = 0) {
  const node = unwrapped(expression);
  if (!node || depth >= maxAliasDepth) return;
  const follow = (child) => archiveModule(child, checker, depth + 1);
  if (ts.isIdentifier(node)) {
    const named = importedFrom(node, checker) ?? declaredTypeImport(node, checker);
    if (named) return named.module;
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isParameter(declaration)) {
      const callback = callbackOf(declaration);
      const library = callback && libraryCall(callback.call, { checker });
      if (callback?.index === 1 && library?.module === 'yauzl' && (library.method ?? library.exported) === 'open') {
        return library.module;
      }
    }
    return follow(constValue(node, checker));
  }
  if (ts.isNewExpression(node)) return follow(node.expression);
  if (ts.isPropertyAccessExpression(node)) return follow(node.expression);
  if (!ts.isCallExpression(node)) return;
  const library = libraryCall(node, { checker });
  if (archiveFields.has(library?.module)) return library.module;
  const callee = unwrapped(node.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  if (callee.name.text === 'pipe') return follow(node.arguments[0]);
  return follow(callee.expression);
}

function collectionModule(expression, checker, depth = 0) {
  const node = unwrapped(expression);
  if (!node || depth >= maxAliasDepth) return;
  if (ts.isIdentifier(node)) return collectionModule(constValue(node, checker), checker, depth + 1);
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'files') return archiveModule(node.expression, checker);
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const { expression: receiver, name } = node.expression;
  if (entryCollections.has(name.text)) return archiveModule(receiver, checker);
  if (name.text === 'values' && ts.isIdentifier(receiver) && receiver.text === 'Object') {
    const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
    if (!declaration || declaration.getSourceFile().isDeclarationFile) {
      return collectionModule(node.arguments[0], checker, depth + 1);
    }
  }
}

function entry(moduleName, declaration) {
  const field = archiveFields.get(moduleName);
  if (field) return { container: { fields: { [field]: scalar } }, label: declaration.name.getText() };
}

function archiveParameter(parameter, checker) {
  const callback = callbackOf(parameter);
  const callee = callback && unwrapped(callback.call.expression);
  if (!callee || !ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const receiver = callee.expression;
  const [event] = callback.call.arguments;
  if (
    callback.index === 0 &&
    entryEvents.has(method) &&
    event &&
    ts.isStringLiteralLike(event) &&
    event.text === 'entry'
  ) {
    return entry(archiveModule(receiver, checker), parameter);
  }
  if (method !== 'forEach') return;
  if (archiveModule(receiver, checker) === 'jszip') {
    if (callback.index === 0) return { taint: 'scalar', label: parameter.name.getText() };
    if (callback.index === 1) return entry('jszip', parameter);
  }
  if (callback.index === 0) return entry(collectionModule(receiver, checker), parameter);
}

function archiveLoopEntry(declaration, checker) {
  const loop = declaration.parent.parent;
  if (ts.isForOfStatement(loop)) return entry(collectionModule(loop.expression, checker), declaration);
}

module.exports = { archiveParameter, archiveLoopEntry };
