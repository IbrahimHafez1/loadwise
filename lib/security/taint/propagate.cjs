'use strict';

// Calls that carry taint from an input to their result (design section 2.3). Any call not listed here, and not a
// project-local function with a return summary, returns a clean value: under-tainting is the precision lever.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { couldBeString } = require('./sanitizers.cjs');

// For a string receiver these operations return a string or split it into an array of strings.
const stringResultMethods = [
  'toString',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'normalize',
  'slice',
  'substring',
  'substr',
  'split',
  'replace',
  'replaceAll',
  'padStart',
  'padEnd',
];

// `value.trim()`: the result carries the receiver's taint.
const receiverMethods = new Set([
  ...stringResultMethods,
  'valueOf',
  'join',
  'concat',
  'map',
  'filter',
  'find',
  'at',
  'flat',
  'flatMap',
]);
const stringResultMethodNames = new Set(stringResultMethods);

// Global functions whose result carries their first argument's taint. `String` is a sanitizer for NoSQL filters.
const globalFunctions = new Set(['String', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'structuredClone']);

// Module or global namespaces: exported function -> 'first' (argument 0), 'any' (any argument), or 'keep' (argument
// 0 with its `whole` flag kept, for copies of the whole object).
const namespaceFunctions = {
  JSON: { parse: 'first', stringify: 'first' },
  Buffer: { from: 'first' },
  Object: { assign: 'keep-any', fromEntries: 'first', entries: 'first', keys: 'first', values: 'first' },
  path: { join: 'any', resolve: 'any', normalize: 'first' },
  url: { parse: 'first' },
  querystring: { parse: 'first' },
  qs: { parse: 'first' },
  lodash: { get: 'first', pick: 'first', omit: 'keep', clone: 'keep', cloneDeep: 'keep' },
};
const globalNamespaces = new Set(['JSON', 'Buffer', 'Object']);

function isGlobal(identifier, checker) {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  return !declaration || declaration.getSourceFile().isDeclarationFile;
}

// How a call propagates: { from: 'receiver' } or { from: 'first' | 'any' | 'keep' | 'keep-any', name }, or
// undefined when it does not.
function propagation(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) {
    if (globalFunctions.has(callee.text) && isGlobal(callee, checker)) return { from: 'first', name: callee.text };
    const binding = importedFrom(callee, checker);
    const mode = binding && namespaceFunctions[binding.module]?.[binding.exported];
    return mode ? { from: mode, name: binding.exported } : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (ts.isIdentifier(receiver)) {
    const binding = importedFrom(receiver, checker);
    const namespace = binding
      ? (binding.exported === '*' || binding.exported === 'default') && binding.module
      : globalNamespaces.has(receiver.text) && isGlobal(receiver, checker) && receiver.text;
    if (namespace && namespaceFunctions[namespace]) {
      const mode = namespaceFunctions[namespace][method];
      return mode ? { from: mode, name: method } : undefined;
    }
  }
  if (receiverMethods.has(method)) {
    return {
      from: 'receiver',
      name: method,
      stringResult: stringResultMethodNames.has(method) && couldBeString(callee.expression, checker),
    };
  }
}

module.exports = { propagation };
