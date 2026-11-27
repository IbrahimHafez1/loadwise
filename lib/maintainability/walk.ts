import type { Node } from 'typescript';
import { childBuffer, bufferChildren, clearChildBuffer } from './child-buffer.js';

// Visits every node in source order. An explicit stack keeps operator chains thousands deep off the
// call stack.
function walkNodes(root: Node, visit: (node: Node) => void): void {
  const pending = [root];
  try {
    for (let node = pending.pop(); node; node = pending.pop()) {
      visit(node);
      for (let index = bufferChildren(node) - 1; index >= 0; index--) pending.push(childBuffer[index]);
    }
  } finally {
    clearChildBuffer();
  }
}

export { walkNodes };
