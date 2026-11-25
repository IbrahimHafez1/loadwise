import { ts, functionWithBody } from './helpers.js';
import type {
  BinaryExpression,
  BreakOrContinueStatement,
  Identifier,
  Node,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  Statement,
  Symbol,
  TypeChecker,
} from 'typescript';
import type { Placement } from '../types/extract-block.js';

// Calls nodes of `root` that run as part of it, skipping the bodies of nested functions and
// classes.
export function forOwnNodes(root: Node, visit: (node: Node) => boolean | void): void {
  (function walk(node: Node): void {
    if (visit(node) === false) return;
    if (node !== root && (functionWithBody(node) || ts.isClassLike(node))) return;
    ts.forEachChild(node, walk);
  })(root);
}

export function contains(outer: Node, inner: Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

export function isAssignment(node: Node): node is BinaryExpression {
  return ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind);
}

export function isIncrement(node: Node): node is PrefixUnaryExpression | PostfixUnaryExpression {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

export function bindingList(declaration: Node) {
  let node: Node | undefined = declaration;
  while (node && (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)))
    node = node.parent;
  if (node && ts.isVariableDeclaration(node)) return node.parent;
}

export function symbolOf(checker: TypeChecker, identifier: Identifier): Symbol | undefined {
  const parent = identifier.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier)
    return checker.getShorthandAssignmentValueSymbol(parent);
  return checker.getSymbolAtLocation(identifier);
}

// The statement a break or continue leaves, by label or as the nearest loop (or switch, for break).
function jumpTarget(jump: BreakOrContinueStatement): Node | undefined {
  for (let node: Node | undefined = jump.parent; node; node = node.parent) {
    if (functionWithBody(node)) return;
    if (jump.label) {
      if (ts.isLabeledStatement(node) && node.label.text === jump.label.text) return node;
    } else if (ts.isIterationStatement(node, false) || (ts.isBreakStatement(jump) && ts.isSwitchStatement(node)))
      return node;
  }
}

const leavingKinds = new Set([
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.FunctionDeclaration,
]);

const awaitUsing = ts.NodeFlags.Const | ts.NodeFlags.Using;

// The statement cannot run inside a function of its own unchanged.
export function leavesFunction(statement: Statement): boolean {
  let blocked = false;
  forOwnNodes(statement, (node: Node) => {
    if (blocked) return false;
    if (leavingKinds.has(node.kind) || (ts.isForOfStatement(node) && node.awaitModifier)) blocked = true;
    else if (ts.isBreakOrContinueStatement(node)) blocked = !contains(statement, jumpTarget(node) ?? statement.parent);
    // var is visible to the rest of the function, and `await using` awaits when the block ends.
    else if (ts.isVariableDeclarationList(node))
      blocked = !(node.flags & ts.NodeFlags.BlockScoped) || (node.flags & awaitUsing) === awaitUsing;
    // A super() call must stay in the constructor body.
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) blocked = true;
    return !blocked;
  });
  return blocked;
}

function isMemberName(identifier: Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isQualifiedName(parent)) return parent.right === identifier;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === identifier
  );
}

// How the statement uses its function's own `this`, looking through arrows, which share it: 'this'
// for this or super, 'blocked' for arguments or new.target, which a new function would answer
// differently.
export function receiverUse(statement: Statement): 'blocked' | 'this' | undefined {
  let use: 'blocked' | 'this' | undefined;
  (function walk(node: Node): void {
    if (use === 'blocked') return;
    if (node !== statement && ((functionWithBody(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node))) return;
    if (ts.isMetaProperty(node) || (ts.isIdentifier(node) && node.text === 'arguments' && !isMemberName(node)))
      use = 'blocked';
    else if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) use = 'this';
    ts.forEachChild(node, walk);
  })(statement);
  return use;
}

// Where the function goes. Inside a non-static class member it becomes a private method after that
// member, so it keeps `this`; anywhere else a function declared after the top-level statement,
// which needs no `this`.
export function placementOf(statement: Statement, receiver: boolean): Placement | undefined {
  for (let node: Node | undefined = statement.parent; node; node = node.parent) {
    if (ts.isArrowFunction(node)) continue;
    const memberNode = functionWithBody(node) || ts.isPropertyDeclaration(node) ? node : undefined;
    if (
      memberNode &&
      memberNode.parent &&
      ts.isClassLike(memberNode.parent) &&
      !ts.isClassStaticBlockDeclaration(memberNode)
    ) {
      const isStatic = memberNode.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
      if (!isStatic) return { method: true, container: memberNode };
    }
    if (functionWithBody(node) || ts.isClassLike(node) || ts.isClassStaticBlockDeclaration(node)) break;
  }
  if (receiver) return;
  let top: Node = statement;
  while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
  if (top.parent) return { method: false, container: top };
}
