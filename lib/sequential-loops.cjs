'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { outerExpression } = require('./repeated.cjs');

const collectionGrowers = new Set(['push', 'add', 'set', 'unshift']);

function bindingNames(name, names = new Set()) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

function mentions(node, names) {
  if (ts.isIdentifier(node)) return names.has(node.text);
  return !!ts.forEachChild(node, (child) => mentions(child, names) || undefined);
}

function resultNames(call) {
  let expression = outerExpression(call);
  if (ts.isAwaitExpression(expression.parent)) expression = outerExpression(expression.parent);
  const declaration = expression.parent;
  return ts.isVariableDeclaration(declaration) && declaration.initializer === expression
    ? bindingNames(declaration.name)
    : new Set();
}

// The native compiler does not export ts.isIterationStatement.
function isLoop(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isBreakTarget(node) {
  return isLoop(node) || ts.isSwitchStatement(node);
}

// A statement that ends the loop: return/throw anywhere, or an unlabelled break that targets this loop.
function leavesLoop(node, nested = false) {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBreakStatement(node)) return !node.label && !nested;
  const insideInner = nested || isBreakTarget(node);
  return !!ts.forEachChild(node, (child) => leavesLoop(child, insideInner) || undefined);
}

function rootIdentifier(expression) {
  let value = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))
    value = ts.skipOuterExpressions(value.expression);
  return ts.isIdentifier(value) ? value : undefined;
}

function loopCondition(owner) {
  return ts.isForStatement(owner) ? owner.condition : owner.expression;
}

function conditionNamesOf(owner) {
  const names = new Set();
  const condition = loopCondition(owner);
  if (condition) {
    (function collect(node) {
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, collect);
    })(condition);
  }
  return names;
}

function isOpenEnded(owner) {
  const condition = loopCondition(owner);
  return !condition || ts.skipOuterExpressions(condition).kind === ts.SyntaxKind.TrueKeyword;
}

function usesLoopCounter(call, owner) {
  if (!ts.isForStatement(owner) || !owner.initializer || !ts.isVariableDeclarationList(owner.initializer)) return false;
  const counters = new Set();
  for (const declaration of owner.initializer.declarations) bindingNames(declaration.name, counters);
  // `const id = ids[index]` makes id a per-iteration value too.
  (function collectDerived(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer && mentions(node.initializer, counters))
      bindingNames(node.name, counters);
    ts.forEachChild(node, collectDerived);
  })(owner.statement);
  return mentions(call, counters);
}

const mutatingMethods = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'insert',
  'create',
  'createMany',
  'upsert',
]);
const mutatingSql = /^\s*(?:update|delete|insert|with)\b/i;

// prisma.x.deleteMany(...), db.delete(t).where(...), pool.query('DELETE ...').
function isMutation(call) {
  for (let node = ts.skipOuterExpressions(call); ts.isCallExpression(node);) {
    const callee = ts.skipOuterExpressions(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (mutatingMethods.has(callee.name.text)) return true;
    if (callee.name.text === 'query') {
      const [text] = node.arguments;
      return !!text && ts.isStringLiteralLike(text) && mutatingSql.test(text.text);
    }
    node = ts.skipOuterExpressions(callee.expression);
  }
  return false;
}

// Result-dependent loop: the call's own result decides whether another round runs (drain or page until empty,
// regenerate until unique), so each round needs the previous one and cannot be folded into one query.
function resultDrivesLoop(call, owner) {
  if (!ts.isWhileStatement(owner) && !ts.isDoStatement(owner) && !ts.isForStatement(owner)) return false;
  const tainted = resultNames(call);
  if (!tainted.size || usesLoopCounter(call, owner)) return false;
  const conditionNames = conditionNamesOf(owner);
  // A counted loop whose counter never reaches the query is a bounded pass limit, not an item iteration.
  const endsOnResult = isOpenEnded(owner) || ts.isForStatement(owner);
  let exitsOnResult = false;
  // A read that is re-run unchanged is a stationary re-read unless the loop acts on what it fetched.
  let consumesResult = false;

  function visit(node, underTaintedBranch) {
    if (ts.isFunctionLike(node)) return false;
    if (ts.isVariableDeclaration(node) && node.initializer && mentions(node.initializer, tainted)) {
      bindingNames(node.name, tainted);
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      mentions(node.expression, tainted)
    ) {
      bindingNames(node.initializer.declarations[0].name, tainted);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = ts.isIdentifier(node.left) ? node.left : undefined;
      if (target && conditionNames.has(target.text) && (underTaintedBranch || mentions(node.right, tainted)))
        return true;
    }
    if (ts.isCallExpression(node) && node.arguments.some((argument) => mentions(argument, tainted))) {
      consumesResult = true;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const root = rootIdentifier(node.expression.expression);
      if (
        root &&
        conditionNames.has(root.text) &&
        collectionGrowers.has(node.expression.name.text) &&
        node.arguments.some((argument) => mentions(argument, tainted))
      )
        return true;
    }
    if (ts.isIfStatement(node)) {
      const branchTainted = mentions(node.expression, tainted);
      if (
        branchTainted &&
        endsOnResult &&
        (leavesLoop(node.thenStatement) || (node.elseStatement && leavesLoop(node.elseStatement)))
      )
        exitsOnResult = true;
      return (
        visit(node.expression, underTaintedBranch) ||
        visit(node.thenStatement, underTaintedBranch || branchTainted) ||
        (!!node.elseStatement && visit(node.elseStatement, underTaintedBranch || branchTainted))
      );
    }
    return !!ts.forEachChild(node, (child) => visit(child, underTaintedBranch) || undefined);
  }
  return visit(owner.statement, false) || (exitsOnResult && (consumesResult || isMutation(call)));
}

function continuesLoop(node) {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isContinueStatement(node)) return !node.label;
  if (isLoop(node)) return false;
  return !!ts.forEachChild(node, (child) => continuesLoop(child) || undefined);
}

// try { await query } catch { continue }: an attempt loop retries after a failure (for example a unique
// violation). In a collection loop or a loop that consumes a queue, continue only moves on to the next item.
function retriesAfterFailure(call, owner) {
  const attemptLoop = ts.isForStatement(owner) && !usesLoopCounter(call, owner);
  if (!attemptLoop && !(ts.isWhileStatement(owner) && isOpenEnded(owner))) return false;
  for (let node = call; node !== owner && node.parent; node = node.parent) {
    const parent = node.parent;
    if (ts.isFunctionLike(parent)) return false;
    if (
      ts.isTryStatement(parent) &&
      parent.tryBlock === node &&
      parent.catchClause &&
      continuesLoop(parent.catchClause)
    )
      return true;
  }
  return false;
}

function isSequentialByDesign(call, owner) {
  return !!owner && !ts.isFunctionLike(owner) && (resultDrivesLoop(call, owner) || retriesAfterFailure(call, owner));
}

module.exports = { isSequentialByDesign };
