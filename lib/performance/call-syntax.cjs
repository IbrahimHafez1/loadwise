'use strict';

const { syntax: ts } = require('./compiler.cjs');

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function calleeName(call, unwrap) {
  const callee = unwrap ? unwrap(call.expression) : ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// The path of a declaration below node_modules (`@types/node/fs.d.ts`), or undefined for project code.
function modulePathOf(declaration) {
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  return start < 0 ? undefined : filename.slice(start + marker.length);
}

module.exports = { calleeName, modulePathOf, skipParentheses };
