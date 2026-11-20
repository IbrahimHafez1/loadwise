const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');

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

function outerExpression(node) {
  let expression = node;
  while (ts.isOuterExpression(expression.parent) && expression.parent.expression === expression) {
    expression = expression.parent;
  }
  return expression;
}

function standardInterface(call, checker) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !isDefaultLibrary(checker, declaration.getSourceFile())) return;
  const owner = declaration.parent;
  if (ts.isInterfaceDeclaration(owner)) return owner.name.text;
}

function isStandardArrayCall(call, checker) {
  return arrayInterfaces.has(standardInterface(call, checker));
}

function isStandardCallback(call, checker) {
  const callee = call.expression;
  let method;
  if (ts.isPropertyAccessExpression(callee)) method = callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    method = callee.argumentExpression.text;
  }
  if (!arrayCallbacks.has(method)) return false;

  // Method names alone would also match custom APIs that store the callback for later.
  const owner = standardInterface(call, checker);
  return arrayInterfaces.has(owner) || (method === 'forEach' && keyedInterfaces.has(owner));
}

function boundedLiteralSize(expression) {
  const collection = ts.skipOuterExpressions(expression);
  if (
    ts.isArrayLiteralExpression(collection) &&
    collection.elements.length <= 1 &&
    !collection.elements.some(ts.isSpreadElement)
  )
    return collection.elements.length;
}

function findRepeatOwner(node, checker) {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      // Destructuring defaults on the left are evaluated for each binding.
      if (child !== parent.expression) {
        const size = ts.isForOfStatement(parent) ? boundedLiteralSize(parent.expression) : undefined;
        if (size === 0) return;
        if (size !== 1) return parent;
      }
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
      const size = boundedLiteralSize(call.expression.expression);
      if (size === 0) return;
      if (size !== 1) return parent;
    } else if (ts.isPropertyDeclaration(parent) && child === parent.initializer) {
      // Instance fields run on construction, potentially long after the surrounding loop.
      if (!(ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Static)) return;
    }
  }
}

function isRepeated(node, checker) {
  return findRepeatOwner(node, checker) !== undefined;
}

module.exports = { findRepeatOwner, isRepeated, isStandardArrayCall, outerExpression, standardInterface };
