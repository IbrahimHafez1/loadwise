import { ts } from './compiler.js';
import type { Expression, Identifier, Node } from 'typescript';
import type { CheckerAdapter } from '../shared/types.js';

function readProperty(object: Expression | undefined, name: string): Expression | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index];
    if (!property.name || ts.isComputedPropertyName(property.name)) return;
    if (property.name.text === name) return ts.isPropertyAssignment(property) ? property.initializer : undefined;
  }
}

function sameBinding(left: Node, right: Node, checker: CheckerAdapter): boolean {
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text !== right.text) return false;
  const declaration = checker.getSymbolAtLocation(left)?.valueDeclaration;
  return !!declaration && declaration === checker.getSymbolAtLocation(right)?.valueDeclaration;
}

function localInitializer(identifier: Identifier, owner: Node, checker: CheckerAdapter): Expression | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.getSourceFile() === owner.getSourceFile() &&
    declaration.pos >= owner.pos &&
    declaration.end <= owner.end
  ) {
    return declaration.initializer;
  }
}

function fixedBatchSize(expression: Expression | undefined, checker: CheckerAdapter): number | undefined {
  if (!expression) return;
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
      return;
    expression = declaration.initializer;
  }
  if (expression && ts.isNumericLiteral(expression) && Number(expression.text) > 1) return Number(expression.text);
}

export { fixedBatchSize, localInitializer, readProperty, sameBinding };
