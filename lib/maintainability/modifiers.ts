import ts from 'typescript';
import type { Node, SyntaxKind } from 'typescript';

// Whether a declaration carries the modifier keyword, such as `export`, `static` or `declare`.
function hasModifier(node: Node, kind: SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

export { hasModifier };
