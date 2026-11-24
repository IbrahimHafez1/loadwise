// @ts-check
import { requireNative } from './native-runtime.cjs';
import type * as TypeScript from 'typescript';
import type {
  CaseOrDefaultClause,
  HasDecorators,
  HasModifiers,
  Modifier,
  ModifierLike,
  Node,
  OptionalChain,
} from 'typescript';
import type { NativeNode } from './types/native-typescript.cjs';
const ast = requireNative('typescript/ast');
const guards = requireNative('typescript/ast/is');
const { getCombinedModifierFlags } = requireNative('typescript/ast/utils');
const { ModifierFlags, ObjectFlags, SymbolFlags, TypeFlags } = requireNative('typescript/sync');

function findAncestor<Match extends Node>(
  node: Node | undefined,
  predicate: (candidate: Node) => candidate is Match,
): Match | undefined;
function findAncestor(node: Node | undefined, predicate: (candidate: Node) => boolean | 'quit'): Node | undefined;
function findAncestor(node: Node | undefined, predicate: (candidate: Node) => boolean | 'quit'): Node | undefined {
  for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
    if (predicate(ancestor)) return ancestor;
  }
}

// A write to the length property cannot be replaced with a count. An assignment
// target can be nested inside a destructuring pattern or transparent wrapper.
function isAssignmentTarget(node: Node): boolean {
  for (let parent: Node | undefined = node.parent; parent; parent = node.parent) {
    if (guards.isBinaryExpression(parent)) {
      return parent.left === node && guards.isAssignmentOperator(parent.operatorToken.kind);
    }
    if (guards.isPrefixUnaryExpression(parent) || guards.isPostfixUnaryExpression(parent)) {
      return parent.operator === ast.SyntaxKind.PlusPlusToken || parent.operator === ast.SyntaxKind.MinusMinusToken;
    }
    if (guards.isForInStatement(parent) || guards.isForOfStatement(parent)) return parent.initializer === node;
    if (
      guards.isSpreadAssignment(parent) ||
      (guards.isPropertyAssignment(parent) && parent.initializer === node) ||
      (guards.isShorthandPropertyAssignment(parent) && parent.name === node)
    ) {
      node = parent.parent;
      continue;
    }
    if (
      !guards.isParenthesizedExpression(parent) &&
      !guards.isArrayLiteralExpression(parent) &&
      !guards.isNonNullExpression(parent) &&
      !guards.isSpreadElement(parent)
    )
      return false;
    node = parent;
  }
  return false;
}

// Decorators sit in the modifier list, as in TypeScript 5 and later.
function getDecorators(node: HasDecorators) {
  const decorators = node.modifiers?.filter(guards.isDecorator);
  return decorators?.length ? decorators : undefined;
}

function isCaseOrDefaultClause(node: Node): node is CaseOrDefaultClause {
  return guards.isCaseClause(node) || guards.isDefaultClause(node);
}

// Any native node that carries a modifier list can have modifiers; the rest read as having none.
function canHaveModifiers(node: Node): node is HasModifiers {
  return 'modifiers' in node;
}

function isModifier(candidate: ModifierLike): candidate is Modifier {
  return !guards.isDecorator(candidate);
}

function getModifiers(node: HasModifiers): readonly Modifier[] | undefined {
  const modifiers: Modifier[] = [];
  for (const candidate of node.modifiers ?? []) {
    if (isModifier(candidate)) modifiers.push(candidate);
  }
  return modifiers.length ? modifiers : undefined;
}

function canHaveDecorators(node: Node): node is HasDecorators {
  return (
    guards.isParameterDeclaration(node) ||
    guards.isPropertyDeclaration(node) ||
    guards.isMethodDeclaration(node) ||
    guards.isGetAccessorDeclaration(node) ||
    guards.isSetAccessorDeclaration(node) ||
    guards.isClassDeclaration(node) ||
    guards.isClassExpression(node)
  );
}

function isNativeNode(node: Node): node is NativeNode {
  return 'forEachChild' in node;
}

function forEachChildOf<Result>(node: Node, visit: (child: Node) => Result | undefined): Result | undefined {
  if (!isNativeNode(node)) throw new Error('Expected a node produced by the native compiler.');
  return node.forEachChild(visit);
}

const nativeSyntax: Partial<typeof TypeScript> = {
  ...ast,
  ...guards,
  ModifierFlags,
  ObjectFlags,
  SymbolFlags,
  TypeFlags,
  getCombinedModifierFlags,
  isFunctionLike: guards.isFunctionLikeDeclaration,
  isClassLike: guards.isClassLikeDeclaration,
  isParameter: guards.isParameterDeclaration,
  isStringLiteralLike: guards.isStringLiteralLikeNode,
  isOptionalChain: (node: Node): node is OptionalChain => Boolean(node.flags & ast.NodeFlags.OptionalChain),
  forEachChild: <Result,>(node: Node, visit: (child: Node) => Result | undefined): Result | undefined =>
    forEachChildOf(node, visit),
  findAncestor,
  isAssignmentTarget,
  isTypeAssertionExpression: guards.isTypeAssertion,
  isPropertySignature: guards.isPropertySignatureDeclaration,
  isMethodSignature: guards.isMethodSignatureDeclaration,
  isCaseOrDefaultClause,
  getDecorators,
  canHaveDecorators,
  getModifiers,
  canHaveModifiers,
};

// The native syntax stands in for the `typescript` module wherever the rules call `loadSyntax()`;
// it implements the subset of that module the rules use.
// The rules read only that subset, so this one assertion widens the partial module to the full type.
// oxlint-disable-next-line typescript/consistent-type-assertions -- the object is a deliberate partial of the compiler module
export default nativeSyntax as typeof TypeScript;
