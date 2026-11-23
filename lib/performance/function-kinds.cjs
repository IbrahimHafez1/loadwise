'use strict';

const { syntax: ts } = require('./compiler.cjs');

function isAsyncFunction(node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

module.exports = { isAsyncFunction };
