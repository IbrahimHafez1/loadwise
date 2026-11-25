// Small readers of declaration nodes shared by the security rules.
import { ts } from '../performance/compiler.js';
import type { Node, TypeNode } from 'typescript';

// The identifier or string a declaration is named by, when it has a name.
function declaredNameOf(declaration: Node | undefined): string | undefined {
  if (!declaration || !('name' in declaration)) return;
  const name = declaration.name;
  if (typeof name !== 'object' || name === null || !('text' in name)) return;
  return typeof name.text === 'string' ? name.text : undefined;
}

// The annotated type of a declaration that can carry one.
function typeAnnotationOf(declaration: Node): TypeNode | undefined {
  const hasAnnotation =
    ts.isParameter(declaration) ||
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isFunctionLike(declaration);
  return hasAnnotation ? declaration.type : undefined;
}

// The body of a function-like node; undefined for anything else.
function bodyOf(node: Node): Node | undefined {
  return ts.isFunctionLike(node) && 'body' in node ? node.body : undefined;
}

export { declaredNameOf, typeAnnotationOf, bodyOf };
