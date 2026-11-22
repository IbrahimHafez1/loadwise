'use strict';

const { syntax: ts } = require('../compiler.cjs');

function mentionsName(node, name) {
  if (ts.isIdentifier(node)) return node.text === name;
  return Boolean(ts.forEachChild(node, (child) => mentionsName(child, name) || undefined));
}

function declaredBinding(node) {
  const isDeclaration =
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node);
  return isDeclaration ? node.name : undefined;
}

// True when anything under `root` declares `name`, so code inserted there could read a different binding.
function declaresName(root, name) {
  let found = false;
  (function visit(node) {
    if (found) return;
    const binding = declaredBinding(node);
    if (binding && mentionsName(binding, name)) found = true;
    else ts.forEachChild(node, visit);
  })(root);
  return found;
}

module.exports = { declaresName };
