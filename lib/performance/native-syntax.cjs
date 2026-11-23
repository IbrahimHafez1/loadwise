// @ts-check
'use strict';

const { requireNative } = require('./native-runtime.cjs');
const ast = requireNative('typescript/ast');
const guards = requireNative('typescript/ast/is');
const { getCombinedModifierFlags } = requireNative('typescript/ast/utils');
const { ModifierFlags, ObjectFlags, SymbolFlags, TypeFlags } = requireNative('typescript/sync');

function findAncestor(node, predicate) {
  for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
    if (predicate(ancestor)) return ancestor;
  }
}

// A write to the length property cannot be replaced with a count. An assignment
// target can be nested inside a destructuring pattern or transparent wrapper.
function isAssignmentTarget(node) {
  for (let parent = node.parent; parent; parent = node.parent) {
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
function getDecorators(node) {
  const decorators = node.modifiers?.filter(guards.isDecorator);
  return decorators?.length ? decorators : undefined;
}

function canHaveDecorators(node) {
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

module.exports = {
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
  isOptionalChain: (node) => Boolean(node.flags & ast.NodeFlags.OptionalChain),
  forEachChild: (node, visit) => node.forEachChild(visit),
  findAncestor,
  isAssignmentTarget,
  isTypeAssertionExpression: guards.isTypeAssertion,
  isPropertySignature: guards.isPropertySignatureDeclaration,
  getDecorators,
  canHaveDecorators,
};
