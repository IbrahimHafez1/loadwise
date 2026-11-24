import ts from 'typescript';
import type { Node } from 'typescript';

// One reused buffer with a static callback avoids allocating per node. Callers copy the children
// out before visiting anything else.
const childBuffer: Node[] = [];
let childCount = 0;
function bufferChild(child: Node): void {
  childBuffer[childCount++] = child;
}

// Visits every node in source order. An explicit stack keeps operator chains thousands deep off the
// call stack.
function walkNodes(root: Node, visit: (node: Node) => void): void {
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    visit(node);
    childCount = 0;
    ts.forEachChild(node, bufferChild);
    for (let index = childCount - 1; index >= 0; index--) pending.push(childBuffer[index]);
  }
}

export { walkNodes };
