import { ts } from '../compiler.js';
import type { Node } from 'typescript';

function mentionsName(node: Node, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  return Boolean(ts.forEachChild(node, (child) => mentionsName(child, name) || undefined));
}

function declaredBinding(node: Node) {
  const isDeclaration =
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node);
  return isDeclaration ? node.name : undefined;
}

// True when anything under `root` declares `name`, so code inserted there could read a different
// binding.
function declaresName(root: Node, name: string): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    const binding = declaredBinding(node);
    if (binding && mentionsName(binding, name)) found = true;
    else ts.forEachChild(node, visit);
  })(root);
  return found;
}

export { declaresName };
