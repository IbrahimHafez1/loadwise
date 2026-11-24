import type { Node } from 'typescript';
import type * as TypeScriptModule from 'typescript';

type Syntax = typeof TypeScriptModule;

// Source rules and site fixes can traverse nodes from different TypeScript engines.
function createReferenceChecks(ts: Syntax) {
  function isPlainReference(node: Node): boolean {
    if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
    return ts.isPropertyAccessExpression(node) && !node.questionDotToken && isPlainReference(node.expression);
  }

  function mentionsIdentifier(node: Node, name: string) {
    let found = false;
    (function visit(child: Node): void {
      if (found) return;
      if (ts.isIdentifier(child) && child.text === name) found = true;
      else ts.forEachChild(child, visit);
    })(node);
    return found;
  }

  return { isPlainReference, mentionsIdentifier };
}

export { createReferenceChecks };
