// Calls that carry taint from an input to their result (design section 2.3). Any call not listed
// here, and not a project-local function with a return summary, returns a clean value:
// under-tainting is the precision lever.
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import { couldBeString } from './sanitizers.js';
import type { CallExpression, Expression, Identifier, Node } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.js';
import type { Propagation, PropagationSource } from '../types/propagation.js';

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

// Global functions whose result carries their first argument's taint. `String` is a sanitizer for
// NoSQL filters.
const globalFunctions = new Set(['String', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'structuredClone']);

// Module or global namespaces: exported function -> 'first' (argument 0), 'any' (any argument), or
// 'keep' (argument 0 with its `whole` flag kept, for copies of the whole object).
const namespaceFunctions: Record<string, Record<string, PropagationSource>> = {
  // Parsing a whole body yields a whole object, which a Mongo filter can take as operators.
  JSON: { parse: 'keep', stringify: 'first' },
  Buffer: { from: 'first' },
  Promise: { resolve: 'keep', all: 'first', allSettled: 'first', race: 'first' },
  Array: { from: 'first' },
  Object: { assign: 'keep-any', fromEntries: 'first', entries: 'first', keys: 'first', values: 'first' },
  path: { join: 'any', resolve: 'any', normalize: 'first' },
  url: { parse: 'first' },
  querystring: { parse: 'first' },
  qs: { parse: 'first' },
  lodash: { get: 'first', pick: 'first', omit: 'keep', clone: 'keep', cloneDeep: 'keep' },
};
const globalNamespaces = new Set(['JSON', 'Buffer', 'Object', 'Promise', 'Array']);

function isGlobal(identifier: Identifier, checker: CheckerAdapter) {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  return !declaration || declaration.getSourceFile().isDeclarationFile;
}

// `ids.map(() => '?')` or `ids.map((_, i) => '$' + (i + 1))`: the result is built without reading
// the element. The third parameter is the whole array, so reading it reads the elements too. Any
// identifier with such a name counts as a read, shadowed or not, so the answer errs towards
// propagating.
function ignoresElement(callback: Expression | undefined): boolean {
  const fn = callback && ts.skipOuterExpressions(callback);
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const [element, , array] = fn.parameters;
  if (!element) return true;
  const elementNames = [element, array].filter((parameter) => parameter !== undefined);
  if (!elementNames.every((parameter) => ts.isIdentifier(parameter.name))) return false;
  const names = new Set(elementNames.map((parameter) => parameter.name.getText()));
  return !(function reads(node: Node): boolean | undefined {
    return (ts.isIdentifier(node) && names.has(node.text)) || ts.forEachChild(node, reads);
  })(fn.body);
}

// How a call propagates: { from: 'receiver' } or { from: 'first' | 'any' | 'keep' | 'keep-any',
// name }, or undefined when it does not.
function propagation(call: CallExpression, checker: CheckerAdapter): Propagation | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) {
    if (globalFunctions.has(callee.text) && isGlobal(callee, checker)) return { from: 'first', name: callee.text };
    const binding = importedFrom(callee, checker);
    const exported = binding?.exported;
    const mode = binding && exported !== undefined ? namespaceFunctions[binding.module]?.[exported] : undefined;
    return mode ? { from: mode, name: exported } : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (ts.isIdentifier(receiver)) {
    const binding = importedFrom(receiver, checker);
    const namespace = binding
      ? (binding.exported === '*' || binding.exported === 'default') && binding.module
      : globalNamespaces.has(receiver.text) && isGlobal(receiver, checker) && receiver.text;
    const functions = namespace ? namespaceFunctions[namespace] : undefined;
    if (functions) {
      const mode = functions[method];
      return mode ? { from: mode, name: method } : undefined;
    }
  }
  if ((method === 'map' || method === 'flatMap') && ignoresElement(call.arguments[0])) return;
  if (receiverMethods.has(method)) {
    return {
      from: 'receiver',
      name: method,
      stringResult: stringResultMethodNames.has(method) && couldBeString(callee.expression, checker),
    };
  }
}

export { propagation };
