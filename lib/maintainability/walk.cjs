'use strict';

const ts = require('typescript');

// One reused buffer with a static callback avoids allocating per node. Callers copy the children out
// before visiting anything else.
const childBuffer = [];
let childCount = 0;
function bufferChild(child) {
  childBuffer[childCount++] = child;
}

// Visits every node in source order. An explicit stack keeps operator chains thousands deep off the call stack.
function walkNodes(root, visit) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    childCount = 0;
    ts.forEachChild(node, bufferChild);
    for (let index = childCount - 1; index >= 0; index--) pending.push(childBuffer[index]);
  }
}

module.exports = { walkNodes };
