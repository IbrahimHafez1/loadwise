import { ts } from './compiler.js';
import { sameBinding } from './query-loop-helpers.js';
import { elementBinding, findRepeatOwner, isStandardArrayCall, outerExpression } from './repeated.js';
import type {
  CallExpression,
  Expression,
  Identifier,
  Node,
  PropertyAccessExpression,
  VariableDeclaration,
} from 'typescript';
import type { CheckerAdapter } from '../shared/types.js';
import type { QueryCall } from './types/query-loops.js';
import type { RepeatOwner } from './types/repeat-owner.js';

// Retry and probe loops rarely run more than a handful of times; larger constants are treated as
// real scans.
const MAX_BOUNDED_ATTEMPTS = 10;
const MAX_LITERAL_ITERATIONS = 5;
// An enum or literal union up to this size is a closed set of values, such as notification
// channels.
const MAX_LITERAL_DOMAIN = 10;
const literalFlags =
  ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.EnumLiteral;
const growingMethods = new Set(['push', 'unshift', 'splice', 'fill', 'copyWithin']);
const objectReaders = new Set(['keys', 'values', 'entries']);

function constantNumber(expression: Expression | undefined, checker: CheckerAdapter): number | undefined {
  if (!expression) return;
  let value: Expression | undefined = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(value)) {
    const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
      return;
    value = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
  }
  if (value && ts.isNumericLiteral(value)) return Number(value.text);
}

function isIncremented(counter: Identifier, loop: Node, checker: CheckerAdapter) {
  return !!(function visit(node: Node): true | undefined {
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      node.operator === ts.SyntaxKind.PlusPlusToken &&
      sameBinding(node.operand, counter, checker)
    )
      return true;
    if (ts.isBinaryExpression(node) && sameBinding(node.left, counter, checker)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) return true;
      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isBinaryExpression(node.right) &&
        node.right.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
        return true;
    }
    return ts.forEachChild(node, visit);
  })(loop);
}

// `while (attempts < maxAttempts)` with an incremented counter and a small constant bound: a retry
// or probe loop.
function boundsCounter(condition: Expression, loop: Node, checker: CheckerAdapter): boolean {
  const value = ts.skipOuterExpressions(condition);
  if (!ts.isBinaryExpression(value)) return false;
  // Any conjunct that caps the counter caps the loop.
  if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return boundsCounter(value.left, loop, checker) || boundsCounter(value.right, loop, checker);
  const inclusive = value.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken;
  if (!ts.isIdentifier(value.left) || (!inclusive && value.operatorToken.kind !== ts.SyntaxKind.LessThanToken))
    return false;
  const limit = constantNumber(value.right, checker);
  return (
    limit !== undefined &&
    limit + (inclusive ? 1 : 0) <= MAX_BOUNDED_ATTEMPTS &&
    isIncremented(value.left, loop, checker)
  );
}

function hasSmallConstantBound(loop: RepeatOwner, checker: CheckerAdapter) {
  if (!ts.isWhileStatement(loop) && !ts.isDoStatement(loop) && !ts.isForStatement(loop)) return false;
  const test = ts.isForStatement(loop) ? loop.condition : loop.expression;
  return !!test && boundsCounter(test, loop, checker);
}

// A flatMap callback that returns a scalar or [] never yields more than one item per input.
function yieldsAtMostOne(result: Expression, checker: CheckerAdapter): boolean {
  const value = ts.skipOuterExpressions(result);
  if (ts.isConditionalExpression(value))
    return yieldsAtMostOne(value.whenTrue, checker) && yieldsAtMostOne(value.whenFalse, checker);
  if (ts.isArrayLiteralExpression(value)) return value.elements.length <= 1 && !value.elements.some(ts.isSpreadElement);
  const type = checker.getTypeAtLocation(value);
  return !(type.isUnion() ? (type.types ?? []) : [type]).some(
    (member) => member.getSymbol()?.name === 'Array' || member.getSymbol()?.name === 'ReadonlyArray',
  );
}

function flatMapKeepsSize(call: CallExpression, checker: CheckerAdapter) {
  const callback = call.arguments[0];
  if (!callback || !ts.isArrowFunction(callback)) return false;
  if (ts.isBlock(callback.body)) return false;
  return yieldsAtMostOne(ts.skipOuterExpressions(callback.body), checker);
}

function iteratedCollection(owner: RepeatOwner): Expression | undefined {
  if (ts.isForOfStatement(owner)) return owner.expression;
  if (!ts.isFunctionLike(owner)) return;
  const call = outerExpression(owner).parent;
  return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
    ? call.expression.expression
    : undefined;
}

// A `const` array can still grow, and an empty literal is almost always an accumulator filled
// later.
function isGrownLater(declaration: VariableDeclaration, checker: CheckerAdapter) {
  const scope = ts.findAncestor(declaration, (node: Node) => ts.isBlock(node) || ts.isSourceFile(node)) ?? declaration;
  return !!(function visit(node: Node): true | undefined {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      growingMethods.has(node.expression.name.text) &&
      sameBinding(node.expression.expression, declaration.name, checker)
    )
      return true;
    if (
      ts.isBinaryExpression(node) &&
      ts.isElementAccessExpression(node.left) &&
      ts.isAssignmentOperator(node.operatorToken.kind) &&
      sameBinding(node.left.expression, declaration.name, checker)
    )
      return true;
    return ts.forEachChild(node, visit);
  })(scope);
}

// `Object.values(Status)` over an enum, or `Object.keys(LIMITS)` over a `const` object literal: a
// key set fixed in the source, no larger than a literal domain.
function readsFixedKeys(call: CallExpression, callee: PropertyAccessExpression, checker: CheckerAdapter) {
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (
    !ts.isIdentifier(receiver) ||
    receiver.text !== 'Object' ||
    !objectReaders.has(callee.name.text) ||
    call.arguments.length !== 1
  )
    return false;
  const target = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isIdentifier(target)) return false;
  let symbol = checker.getSymbolAtLocation(target);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (!declaration) return false;
  if (ts.isEnumDeclaration(declaration)) return declaration.members.length <= MAX_LITERAL_DOMAIN;
  if (!ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
  const table = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
  return (
    !!table &&
    ts.isObjectLiteralExpression(table) &&
    table.properties.length <= MAX_LITERAL_DOMAIN &&
    !table.properties.some(ts.isSpreadAssignment)
  );
}

function isSmallLiteralCollection(expression: Expression | undefined, checker: CheckerAdapter, depth = 0): boolean {
  if (!expression || depth > 6) return false;
  const value = ts.skipOuterExpressions(expression);
  if (ts.isArrayLiteralExpression(value))
    return (
      value.elements.length > 0 &&
      value.elements.length <= MAX_LITERAL_ITERATIONS &&
      !value.elements.some(ts.isSpreadElement)
    );
  if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
    if (readsFixedKeys(value, value.expression, checker)) return true;
    // These array methods never return more items than the receiver holds.
    const method = value.expression.name.text;
    return (
      (['filter', 'slice', 'map'].includes(method) || (method === 'flatMap' && flatMapKeepsSize(value, checker))) &&
      isStandardArrayCall(value, checker) &&
      isSmallLiteralCollection(value.expression.expression, checker, depth + 1)
    );
  }
  if (!ts.isIdentifier(value)) return false;
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const) &&
    isSmallLiteralCollection(declaration.initializer, checker, depth + 1) &&
    !isGrownLater(declaration, checker)
  );
}

// Items typed as a small literal union, such as the members of an enum, can take only a few
// distinct values.
function hasSmallLiteralDomain(owner: RepeatOwner, checker: CheckerAdapter) {
  const binding = elementBinding(owner);
  if (!binding || !ts.isIdentifier(binding)) return false;
  const type = checker.getTypeAtLocation(binding);
  const members = type.isUnion() ? (type.types ?? []) : [type];
  return members.length <= MAX_LITERAL_DOMAIN && members.every((member) => member.flags & literalFlags);
}

function isConstantValue(expression: Expression, checker: CheckerAdapter) {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return true;
  return ts.isPropertyAccessExpression(value) && !!(checker.getTypeAtLocation(value).flags & literalFlags);
}

// `if (channel === Channel.Push) await query()` runs for one value of the loop item, not for every
// item.
function matchesOneItemValue(call: QueryCall, owner: RepeatOwner, checker: CheckerAdapter) {
  const binding = elementBinding(owner);
  if (!binding || !ts.isIdentifier(binding)) return false;
  const comparesItem = (condition: Expression): boolean => {
    const value = ts.skipOuterExpressions(condition);
    if (!ts.isBinaryExpression(value)) return false;
    if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return comparesItem(value.left) || comparesItem(value.right);
    if (
      value.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      value.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
    )
      return false;
    return [
      [value.left, value.right],
      [value.right, value.left],
    ].some(([item, constant]) => sameBinding(item, binding, checker) && isConstantValue(constant, checker));
  };
  for (let current: Node = call; current !== owner && current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isIfStatement(parent) && parent.thenStatement === current && comparesItem(parent.expression)) return true;
  }
  return false;
}

// Retry loops and fixed-size literal lists issue a bounded number of queries that batching cannot
// improve.
function isBoundedLoop(owner: RepeatOwner, checker: CheckerAdapter) {
  if (findRepeatOwner(owner, checker)) return false;
  return (
    hasSmallConstantBound(owner, checker) ||
    isSmallLiteralCollection(iteratedCollection(owner), checker) ||
    hasSmallLiteralDomain(owner, checker)
  );
}

export { isBoundedLoop, isGrownLater, matchesOneItemValue };
