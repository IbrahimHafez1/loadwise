'use strict';

// Source rules and site fixes can traverse nodes from different TypeScript engines.
function createReferenceChecks(ts) {
  function isPlainReference(node) {
    if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
    return ts.isPropertyAccessExpression(node) && !node.questionDotToken && isPlainReference(node.expression);
  }

  function mentionsIdentifier(node, name) {
    let found = false;
    (function visit(child) {
      if (found) return;
      if (ts.isIdentifier(child) && child.text === name) found = true;
      else ts.forEachChild(child, visit);
    })(node);
    return found;
  }

  return { isPlainReference, mentionsIdentifier };
}

module.exports = { createReferenceChecks };
