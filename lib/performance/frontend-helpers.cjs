'use strict';

// Constants and helpers shared by the frontend performance rule modules: where a name comes from (its import, or the
// lib.dom declaration behind it) and the AST walks the rules use.
const { syntax: ts } = require('./compiler.cjs');
const { importedFrom } = require('../security/bindings.cjs');

const REACT_MODULES = ['react', 'preact', 'preact/hooks', 'preact/compat'];
const VUE_MODULES = ['vue', '@vue/runtime-core'];
const ANGULAR_MODULES = ['@angular/core'];

const REACT_EFFECTS = new Set(['useEffect', 'useLayoutEffect']);
const DOM_LIB_FILE = /[\\/]lib\.(?:dom|webworker)(?:\.[a-z]+)*\.d\.ts$/;

function calleeName(call) {
  const expression = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
}

// The export name `expression` refers to when it is imported from one of `modules`: `useEffect`, `React.useEffect`.
function importedName(expression, checker, modules) {
  const target = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(target)) {
    const binding = importedFrom(target, checker);
    return binding && modules.includes(binding.module) ? binding.exported : undefined;
  }
  if (!ts.isPropertyAccessExpression(target)) return;
  const binding = importedFrom(target.expression, checker);
  const isWholeModule = binding && (binding.exported === '*' || binding.exported === 'default');
  return isWholeModule && modules.includes(binding.module) ? target.name.text : undefined;
}

function declaredInDomLibrary(symbol) {
  return Boolean(symbol?.declarations?.some((declaration) => DOM_LIB_FILE.test(declaration.getSourceFile().fileName)));
}

function domSymbolOf(node, checker) {
  return checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
}

function ownerNameOf(symbol) {
  const owner = symbol?.declarations?.[0]?.parent;
  return owner && owner.name && ts.isIdentifier(owner.name) ? owner.name.text : undefined;
}

// `setInterval`, `window.setInterval`, `new WebSocket(...)`: the callee is the browser's own declaration.
function isBrowserGlobal(callee, checker) {
  return declaredInDomLibrary(domSymbolOf(ts.skipOuterExpressions(callee), checker));
}

// `window`, `document`, `document.body`: targets that outlive any component.
function isGlobalEventTarget(expression, checker) {
  let current = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(current)) current = ts.skipOuterExpressions(current.expression);
  return ts.isIdentifier(current) && declaredInDomLibrary(checker.getSymbolAtLocation(current));
}

function walkSkippingFunctions(root, visit) {
  (function walk(node) {
    if (node !== root && ts.isFunctionLike(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  })(root);
}

function walkAll(root, visit) {
  (function walk(node) {
    visit(node);
    ts.forEachChild(node, walk);
  })(root);
}

function containsReturnValue(body) {
  let found = false;
  walkSkippingFunctions(body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) found = true;
  });
  return found;
}

function effectCallback(call, checker) {
  const hook = importedName(call.expression, checker, REACT_MODULES);
  if (!hook || !REACT_EFFECTS.has(hook)) return;
  const callback = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  const isFunction = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback));
  return isFunction && ts.isBlock(callback.body) ? { hook, body: callback.body } : undefined;
}

function isVueImport(expression, checker, exportName) {
  return importedName(expression, checker, VUE_MODULES) === exportName;
}

module.exports = {
  ANGULAR_MODULES,
  REACT_EFFECTS,
  REACT_MODULES,
  VUE_MODULES,
  calleeName,
  containsReturnValue,
  declaredInDomLibrary,
  domSymbolOf,
  effectCallback,
  importedName,
  isBrowserGlobal,
  isGlobalEventTarget,
  isVueImport,
  ownerNameOf,
  walkAll,
  walkSkippingFunctions,
};
