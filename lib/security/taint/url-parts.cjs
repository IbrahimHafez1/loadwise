'use strict';

// Which part of a URL expression the tainted value can control, from the literal text in front of it.
const { syntax: ts } = require('../../performance/compiler.cjs');

// A scheme and a complete host followed by a path, query or fragment: the rest cannot change the host.
const fixedOrigin = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+[/?#]/i;
// A scheme, possibly with a partial host: the rest still chooses the host.
const openHost = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*$/i;

function constantText(node, checker) {
  const value = ts.skipOuterExpressions(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (!ts.isIdentifier(value)) return;
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
    return declaration.initializer && constantText(declaration.initializer, checker);
}

// The literal text that precedes every runtime part, or undefined when the expression starts with a runtime value.
function literalPrefix(expression, checker) {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isTemplateExpression(value)) return value.head.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    let left = value;
    while (ts.isBinaryExpression(left) && left.operatorToken.kind === ts.SyntaxKind.PlusToken)
      left = ts.skipOuterExpressions(left.left);
    return constantText(left, checker);
  }
}

// 'path' when a fixed origin or a relative path precedes the value, 'host' when only a scheme does, else 'whole'.
function urlPart(expression, checker) {
  const prefix = literalPrefix(expression, checker);
  if (!prefix) return 'whole';
  if (fixedOrigin.test(prefix)) return 'path';
  if (openHost.test(prefix)) return 'host';
  // `/${value}` stays on this site unless the value starts with a second slash, which rules check separately.
  if (prefix.startsWith('/') && !prefix.startsWith('//')) return 'path';
  return 'whole';
}

module.exports = { urlPart };
