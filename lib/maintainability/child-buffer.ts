// A reused buffer of a node's children, shared by the walks that avoid per-node allocation.
import ts from 'typescript';
import type { Node } from 'typescript';

// One reused buffer with a static callback avoids allocating per node. Callers copy the children
// out before visiting anything else.
export const childBuffer: Node[] = [];
let childCount = 0;
function bufferChild(child: Node): void {
  childBuffer[childCount++] = child;
}

// Buffers the node's children in forEachChild order and returns how many there are.
export function bufferChildren(node: Node): number {
  childCount = 0;
  ts.forEachChild(node, bufferChild);
  return childCount;
}

// Releases retained AST node references after a walk completes so SourceFiles can be collected.
export function clearChildBuffer(): void {
  childBuffer.length = 0;
  childCount = 0;
}
