'use strict';

// Syntax helpers shared by the exposure rules: option objects, literal values and call shapes.
const { syntax: ts } = require('../../performance/compiler.cjs');

function unwrap(expression) {
  return expression && ts.skipOuterExpressions(expression);
}

function nameText(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

// The object literal an options expression stands for: itself, or a `const` that holds one.
function objectLiteralOf(expression, checker) {
  const node = unwrap(expression);
  if (!node) return;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (!ts.isIdentifier(node)) return;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
    return;
  const initializer = unwrap(declaration.initializer);
  return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
}

// { property, value } for the member `name` of an object literal; value is the unwrapped initializer.
function findProperty(literal, name) {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && nameText(property.name) === name)
      return { property, value: unwrap(property.initializer) };
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name)
      return { property, value: property.name };
  }
}

// A spread or computed key means the literal does not state every option, so a missing one proves nothing.
function isFullyLiteral(literal) {
  return literal.properties.every(
    (property) => !ts.isSpreadAssignment(property) && !(property.name && ts.isComputedPropertyName(property.name)),
  );
}

function isTrue(node) {
  return node?.kind === ts.SyntaxKind.TrueKeyword;
}

function isFalse(node) {
  return node?.kind === ts.SyntaxKind.FalseKeyword;
}

// `res.status(500).json(...)` -> `res`; undefined when the chain does not start at a plain identifier.
function chainRootName(expression) {
  let node = unwrap(expression);
  while (
    node &&
    (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node))
  )
    node = unwrap(node.expression);
  return node && ts.isIdentifier(node) ? node.text : undefined;
}

// The called method name of `receiver.method(...)`.
function methodName(call) {
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

module.exports = {
  unwrap,
  nameText,
  objectLiteralOf,
  findProperty,
  isFullyLiteral,
  isTrue,
  isFalse,
  chainRootName,
  methodName,
};
