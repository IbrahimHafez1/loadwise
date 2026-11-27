import { ts } from '../performance/compiler.js';
import type { Node } from 'typescript';

// Visits every node in source order with the selected compiler, so the native engine's trees walk the same way. An
// explicit stack keeps operator chains thousands deep off the call stack.
function walkNodes(root: Node, visit: (node: Node) => void): void {
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    visit(node);
    const children: Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
}

export { walkNodes };
