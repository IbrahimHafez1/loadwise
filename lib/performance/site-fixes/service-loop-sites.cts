// Call-site detection: the shapes of loop that call the helper per item, the argument that varies,
// and the list expression and call text that replace it.
import { ts, isPlainReference, textOf } from './helpers.cjs';
import { unwrap, references, contains, loopNames } from './service-loop-ast.cjs';
import type { AwaitExpression, BindingName, CallExpression, Expression, ForOfStatement, Node } from 'typescript';
import type { AllSite, LoopSite, PrefetchSite, CallSite } from '../types/call-site.cjs';

const arrayMethods = new Set(['map', 'filter', 'slice', 'concat', 'flat', 'flatMap']);

const objectListers = new Set(['keys', 'values', 'entries']);

// `Promise.all(list.map((item) => helper(item)))`: the helper call is the whole callback body.
export function promiseAllSite(call: CallExpression): AllSite | undefined {
  let expression: Expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const callback = expression.parent;
  if (!callback || !ts.isArrowFunction(callback) || callback.body !== expression || callback.parameters.length !== 1)
    return;
  const map = callback.parent;
  if (!ts.isCallExpression(map) || map.arguments.length !== 1 || !ts.isPropertyAccessExpression(map.expression)) return;
  if (map.expression.name.text !== 'map') return;
  const all = map.parent;
  if (
    !ts.isCallExpression(all) ||
    all.arguments.length !== 1 ||
    all.arguments[0] !== map ||
    textOf(all.expression) !== 'Promise.all'
  )
    return;
  const parameter = callback.parameters[0];
  if (parameter.initializer || parameter.dotDotDotToken) return;
  return {
    kind: 'all',
    all,
    collection: map.expression.expression,
    binding: parameter.name,
    names: loopNames(parameter.name, callback.body),
  };
}

export function awaitedStatement(call: CallExpression): AwaitExpression | undefined {
  let expression: Expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  if (!ts.isAwaitExpression(expression.parent)) return;
  return expression.parent;
}

function forOfBinding(loop: ForOfStatement): BindingName | undefined {
  if (loop.awaitModifier || !ts.isVariableDeclarationList(loop.initializer)) return;
  const declarations = loop.initializer.declarations;
  return declarations.length === 1 ? declarations[0].name : undefined;
}

// `for (const item of list) await helper(item);` with nothing else in the loop.
export function soleLoopSite(call: CallExpression): LoopSite | undefined {
  const awaited = awaitedStatement(call);
  const statement = awaited?.parent;
  if (!awaited || !statement || !ts.isExpressionStatement(statement)) return;
  const container = statement.parent;
  const loop = ts.isBlock(container) && container.statements.length === 1 ? container.parent : container;
  if (!ts.isForOfStatement(loop) || (loop.statement !== statement && loop.statement !== container)) return;
  const binding = forOfBinding(loop);
  if (!binding) return;
  return {
    kind: 'loop',
    loop,
    awaited,
    collection: loop.expression,
    binding,
    names: loopNames(binding, loop.statement),
  };
}

// `await helper(key)` anywhere in a for-of body, outside nested functions and try blocks.
export function prefetchSite(call: CallExpression): PrefetchSite | undefined {
  const awaited = awaitedStatement(call);
  if (!awaited) return;
  for (let current = awaited.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isTryStatement(current)) return;
    if (ts.isForOfStatement(current)) {
      const binding = forOfBinding(current);
      if (!binding) return;
      return {
        kind: 'prefetch',
        loop: current,
        awaited,
        collection: current.expression,
        binding,
        names: loopNames(binding, current.statement),
      };
    }
    if (ts.isIterationStatement(current, false)) return;
  }
}

// The one argument that differs per item; the others must be the same for the whole loop.
export function varyingArgument(
  call: CallExpression,
  site: CallSite,
): { argument: Expression; index: number } | undefined {
  const varying = call.arguments
    .map((argument: Expression, index: number) => ({ argument, index }))
    .filter(({ argument }) => references(argument, site.names));
  if (varying.length !== 1) return;
  if (contains(varying[0].argument, (node: Node) => ts.isAwaitExpression(node) || ts.isFunctionLike(node))) return;
  return varying[0];
}

function isArrayExpression(expression: Expression): boolean {
  const value = unwrap(expression);
  if (ts.isArrayLiteralExpression(value)) return true;
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  const method = value.expression.name.text;
  const receiver = textOf(value.expression.expression);
  return (
    arrayMethods.has(method) ||
    (receiver === 'Object' && objectListers.has(method)) ||
    (receiver === 'Array' && method === 'from')
  );
}

// The list of per-item argument values, as an expression over the loop's collection.
export function listExpression(site: CallSite, argument: Expression, typed: boolean): string {
  const binding = textOf(site.binding);
  const collection = textOf(site.collection);
  const identity = ts.isIdentifier(site.binding) && textOf(argument) === binding;
  // A for-of loop accepts any iterable; .map() needs an array.
  const array =
    site.kind === 'all' || isArrayExpression(site.collection) || (typed && isPlainReference(unwrap(site.collection)));
  if (identity) return array ? collection : `Array.from(${collection})`;
  return array
    ? `${collection}.map((${binding}) => ${textOf(argument)})`
    : `Array.from(${collection}, (${binding}) => ${textOf(argument)})`;
}

function calleeText(call: CallExpression, batchName: string): string {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) ? `${textOf(callee.expression)}.${batchName}` : batchName;
}

export function batchCallText(call: CallExpression, batchName: string, itemIndex: number, list: string): string {
  const parts = call.arguments.map((argument: Expression, index: number) =>
    index === itemIndex ? list : textOf(argument),
  );
  return `${calleeText(call, batchName)}(${parts.join(', ')})`;
}
