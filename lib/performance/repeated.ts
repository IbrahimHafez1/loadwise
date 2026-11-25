import { ts, isDefaultLibrary } from './compiler.js';
import type { BindingName, CallExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter } from '../shared/types.js';
import type { RepeatOwner } from './types/repeat-owner.js';

const arrayCallbacks = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'sort',
  'toSorted',
]);
const arrayInterfaces = new Set(['Array', 'ReadonlyArray']);
const keyedInterfaces = new Set(['Map', 'ReadonlyMap', 'Set', 'ReadonlySet']);

function outerExpression(node: Node): Node {
  let expression = node;
  while (ts.isOuterExpression(expression.parent) && expression.parent.expression === expression) {
    expression = expression.parent;
  }
  return expression;
}

function standardInterface(call: CallExpression, checker: CheckerAdapter): string | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !isDefaultLibrary(checker, declaration.getSourceFile())) return;
  const owner = declaration.parent;
  if (ts.isInterfaceDeclaration(owner)) return owner.name.text;
}

function isStandardArrayCall(call: CallExpression, checker: CheckerAdapter) {
  const owner = standardInterface(call, checker);
  return owner !== undefined && arrayInterfaces.has(owner);
}

function isStandardCallback(call: CallExpression, checker: CheckerAdapter) {
  const callee = call.expression;
  let method: string | undefined;
  if (ts.isPropertyAccessExpression(callee)) method = callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    method = callee.argumentExpression.text;
  }
  if (method === undefined || !arrayCallbacks.has(method)) return false;

  // Method names alone would also match custom APIs that store the callback for later.
  const owner = standardInterface(call, checker);
  if (owner === undefined) return false;
  return arrayInterfaces.has(owner) || (method === 'forEach' && keyedInterfaces.has(owner));
}

function boundedLiteralSize(expression: Expression): number | undefined {
  const collection = ts.skipOuterExpressions(expression);
  if (
    ts.isArrayLiteralExpression(collection) &&
    collection.elements.length <= 1 &&
    !collection.elements.some(ts.isSpreadElement)
  )
    return collection.elements.length;
}

// loadwise-reviewed high-branch-complexity -- one ancestor walk where each branch decides continue, stop or report for one kind of repeating ancestor; splitting needs a continue/stop/owner tri-state that hides the single upward scan
function findRepeatOwner(node: Node, checker: CheckerAdapter): RepeatOwner | undefined {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      // Destructuring defaults on the left are evaluated for each binding.
      if (child === parent.expression) continue;
      const size = ts.isForOfStatement(parent) ? boundedLiteralSize(parent.expression) : undefined;
      if (size === 0) return;
      if (size !== 1) return parent;
    } else if (ts.isForStatement(parent)) {
      if (child !== parent.initializer) return parent;
    } else if (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
      return parent;
    } else if (ts.isFunctionLike(parent)) {
      if ((!ts.isFunctionExpression(parent) && !ts.isArrowFunction(parent)) || parent.asteriskToken) return;
      const expression = outerExpression(parent);
      const call = expression.parent;
      if (!ts.isCallExpression(call)) return;
      if (call.expression === expression) continue;
      if (call.arguments[0] !== expression || !isStandardCallback(call, checker)) return;
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return;
      const size = boundedLiteralSize(callee.expression);
      if (size === 0) return;
      if (size !== 1) return parent;
    } else if (ts.isPropertyDeclaration(parent) && child === parent.initializer) {
      // Instance fields run on construction, potentially long after the surrounding loop.
      if (!(ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Static)) return;
    }
  }
}

function isRepeated(node: Node, checker: CheckerAdapter): boolean {
  return findRepeatOwner(node, checker) !== undefined;
}

const promiseCombinators = new Set(['all', 'allSettled', 'any', 'race']);
const mappingMethods = new Set(['map', 'flatMap']);

function combinatorName(call: Node, argument: Node): string | undefined {
  if (!ts.isCallExpression(call) || call.arguments[0] !== argument) return;
  const callee = ts.skipOuterExpressions(call.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Promise' &&
    promiseCombinators.has(callee.name.text)
  )
    return callee.name.text;
}

// `Promise.all(items.map(async (item) => ...))`, directly or through `const pending =
// items.map(...)`: the callbacks start together, so their awaits overlap instead of running one
// after another.
function promiseCombinatorOf(owner: Node | undefined): string | undefined {
  if (!owner || (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner))) return;
  const iteration = outerExpression(owner).parent;
  if (
    !ts.isCallExpression(iteration) ||
    !ts.isPropertyAccessExpression(iteration.expression) ||
    !mappingMethods.has(iteration.expression.name.text)
  )
    return;
  let mapped = outerExpression(iteration);
  if (ts.isAwaitExpression(mapped.parent)) return;
  const direct = combinatorName(mapped.parent, mapped);
  if (direct) return direct;
  const declaration = mapped.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== mapped ||
    !ts.isIdentifier(declaration.name)
  )
    return;
  const scope = ts.findAncestor(declaration, (node: Node) => ts.isBlock(node) || ts.isSourceFile(node));
  if (!scope) return;
  const variableName = declaration.name;
  let found: string | undefined;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === variableName.text && node !== variableName) {
      mapped = outerExpression(node);
      found = combinatorName(mapped.parent, mapped);
      return;
    }
    ts.forEachChild(node, visit);
  })(scope);
  return found;
}

function elementBinding(owner: Node): BindingName | undefined {
  if (ts.isForOfStatement(owner) && ts.isVariableDeclarationList(owner.initializer))
    return owner.initializer.declarations[0]?.name;
  if (ts.isFunctionLike(owner)) return owner.parameters[0]?.name;
}

export {
  elementBinding,
  findRepeatOwner,
  isRepeated,
  isStandardArrayCall,
  outerExpression,
  promiseCombinatorOf,
  standardInterface,
};
