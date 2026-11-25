import { loadSyntax } from './compiler.cjs';
import { sameBinding } from './query-loop-helpers.cjs';
import { findRepeatOwner, outerExpression } from './repeated.cjs';
import { isBreakTarget } from './sequential-loops.cjs';
import type { BreakStatement, ForStatement, FunctionDeclaration, MethodDeclaration, Node, Statement } from 'typescript';
import type { CheckerAdapter } from '../shared/types.cjs';
import type { QueryCall } from './types/query-loops.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
const ts = loadSyntax();

// A break leaves the scanned loop unless its target, the labelled statement or the nearest loop or
// switch, sits inside that loop, as in a one-item inner `for (const key of [id])`.
function breaksOutOf(statement: BreakStatement, owner: Node) {
  const label = statement.label?.text;
  for (let node = statement.parent; node && node !== owner; node = node.parent) {
    const isTarget = label ? ts.isLabeledStatement(node) && node.label.text === label : isBreakTarget(node);
    if (isTarget) return false;
  }
  return true;
}

function exitsLoop(statement: Statement, owner: Node): boolean {
  if (ts.isBlock(statement)) return statement.statements.length === 1 && exitsLoop(statement.statements[0], owner);
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    (ts.isBreakStatement(statement) && breaksOutOf(statement, owner))
  );
}

function runsAtMostOnce(call: QueryCall, owner: RepeatOwner, checker: CheckerAdapter) {
  if (ts.isFunctionLike(owner)) return false;
  let exits = false;
  let checkedStatement = false;
  for (let current: Node = call; current !== owner; current = current.parent) {
    const parent = current.parent;
    // A catch may retry the failed query; a finally can replace a return with continue.
    if (ts.isTryStatement(parent) || ts.isFunctionLike(parent) || ts.isSwitchStatement(parent)) return false;
    if (ts.isReturnStatement(current) || ts.isThrowStatement(current)) exits = true;
    if (!checkedStatement && ts.isBlock(parent)) {
      checkedStatement = true;
      if (!ts.isVariableStatement(current) && !ts.isExpressionStatement(current)) continue;
      const next = parent.statements[parent.statements.indexOf(current) + 1];
      if (next && exitsLoop(next, owner)) exits = true;
    }
  }
  // An inner break still runs once per outer item. Keep the advisory in ambiguous nested loops.
  return exits && !findRepeatOwner(owner, checker);
}

// `for (let index = 0; index < rows.length; index++)` walks a collection rather than counting
// attempts.
function iteratedByCounter(loop: ForStatement) {
  const condition = loop.condition && ts.skipOuterExpressions(loop.condition);
  return (
    !!condition &&
    ts.isBinaryExpression(condition) &&
    ts.isPropertyAccessExpression(condition.right) &&
    condition.right.name.text === 'length'
  );
}

// `for (let attempt = 0; ; attempt++) { try { return await save(row); } catch { ... } }` repeats
// the call only after a failure. A collection loop that leaves on success still runs it once per
// item.
function retriesUntilSuccess(call: QueryCall, owner: RepeatOwner, checker: CheckerAdapter) {
  if (!ts.isForStatement(owner) && !ts.isWhileStatement(owner) && !ts.isDoStatement(owner)) return false;
  if (ts.isForStatement(owner) && iteratedByCounter(owner)) return false;
  let exits = false;
  let retried = false;
  for (let current: Node = call; current !== owner; current = current.parent) {
    const parent = current.parent;
    if (ts.isFunctionLike(parent) || ts.isSwitchStatement(parent)) return false;
    if (ts.isReturnStatement(current)) exits = true;
    if (ts.isTryStatement(parent) && parent.tryBlock === current && parent.catchClause) retried = true;
    if (!exits && ts.isBlock(parent) && (ts.isVariableStatement(current) || ts.isExpressionStatement(current))) {
      const next = parent.statements[parent.statements.indexOf(current) + 1];
      if (next && exitsLoop(next, owner)) exits = true;
    }
  }
  // A retry inside an item loop still runs once per outer item.
  return exits && retried && !findRepeatOwner(owner, checker);
}

// `const taken = await find(candidate); if (!taken) return candidate;` in a counter loop probes
// until the first free value, so it normally runs once. A collection loop that exits on a miss
// still runs per item.
function probesUntilFree(call: QueryCall, owner: RepeatOwner, checker: CheckerAdapter) {
  if (!ts.isForStatement(owner) && !ts.isWhileStatement(owner) && !ts.isDoStatement(owner)) return false;
  let expression = outerExpression(call);
  if (ts.isAwaitExpression(expression.parent)) expression = outerExpression(expression.parent);
  const declaration = expression.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isVariableStatement(statement) || !ts.isBlock(block) || block.parent !== owner) return false;
  const next = block.statements[block.statements.indexOf(statement) + 1];
  if (!next || !ts.isIfStatement(next) || next.elseStatement) return false;
  const condition = ts.skipOuterExpressions(next.expression);
  const exit = ts.isBlock(next.thenStatement) ? next.thenStatement.statements[0] : next.thenStatement;
  return (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken &&
    sameBinding(ts.skipOuterExpressions(condition.operand), declaration.name, checker) &&
    !!exit &&
    ts.isReturnStatement(exit)
  );
}

function onlyCalledOnFailure(method: MethodDeclaration | FunctionDeclaration) {
  const nameNode = method.name;
  if (!nameNode || !(ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) || !nameNode.text) return false;
  const name = nameNode.text;
  const isPrivate =
    ts.isPrivateIdentifier(nameNode) || !!(ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Private);
  const scope = ts.isMethodDeclaration(method)
    ? isPrivate && method.parent
    : ts.isFunctionDeclaration(method) &&
      !(ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Export) &&
      method.getSourceFile();
  if (!scope) return false;
  let calls = 0;
  let failureOnly = true;
  (function visit(node: Node): void {
    if (!failureOnly) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const matches = ts.isMethodDeclaration(method)
        ? ts.isPropertyAccessExpression(callee) &&
          callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
          callee.name.text === name
        : ts.isIdentifier(callee) && callee.text === name;
      if (matches) {
        calls++;
        if (!insideFailureHandler(node, method)) failureOnly = false;
      }
    }
    ts.forEachChild(node, visit);
  })(scope);
  return calls > 0 && failureOnly;
}

function isFailureCallback(node: Node) {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const call = outerExpression(node).parent;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'catch' &&
    call.arguments[0] === outerExpression(node)
  );
}

// A catch block, a `.catch()` handler, or code reached only through them, up to `boundary`.
function insideFailureHandler(node: Node, boundary?: Node) {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (ts.isCatchClause(current) || isFailureCallback(current)) return true;
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) return false;
  }
  return false;
}

// Rollback and cleanup work that runs only after a failure, not once per item of a normal run.
function onFailurePath(call: QueryCall) {
  if (insideFailureHandler(call)) return true;
  const method = ts.findAncestor(
    call,
    (node: Node) => ts.isFunctionLike(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node),
  );
  return (
    !!method && (ts.isMethodDeclaration(method) || ts.isFunctionDeclaration(method)) && onlyCalledOnFailure(method)
  );
}

export { exitsLoop, onFailurePath, probesUntilFree, retriesUntilSuccess, runsAtMostOnce };
