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

module.exports = { calleeName, skipParentheses };
