// Syntax-tree helpers shared by the service-loop fix modules: reference and scope checks,
// loop-bound names, parameter and property lookups.
import { ts } from './helpers.cjs';
import { isMethodCall } from './method-calls.cjs';
import type {
  BindingName,
  Expression,
  FunctionDeclaration,
  Identifier,
  MethodDeclaration,
  Node,
  ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript';
import type { MethodCall } from '../types/method-call.cjs';
import type { PlainProperty } from '../types/plain-property.cjs';

export function unwrap(node: Expression): Expression {
  return ts.skipOuterExpressions(node);
}

export function references(node: Node, names: ReadonlySet<string>): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found) return;
    if (ts.isIdentifier(child) && names.has(child.text) && !isPropertyName(child)) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

export function isPropertyName(identifier: Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier)
  );
}

export function contains(node: Node, predicate: (node: Node) => boolean): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found) return;
    if (predicate(child)) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

function bindingNames(name: BindingName, names = new Set<string>()): Set<string> {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const element of name.elements ?? []) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

// Names declared by the loop binding and inside its body: values that differ per item.
export function loopNames(binding: BindingName, body: Node): Set<string> {
  const names = bindingNames(binding);
  (function visit(node: Node): void {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.name) bindingNames(node.name, names);
    ts.forEachChild(node, visit);
  })(body);
  return names;
}

// The names of the parameters when every one is a plain identifier, or undefined.
export function simpleParameterNames(declaration: MethodDeclaration | FunctionDeclaration): string[] | undefined {
  const names: string[] = [];
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.initializer) return;
    names.push(parameter.name.text);
  }
  return names;
}

export function objectProperty(object: ObjectLiteralExpression, key: string): PlainProperty | undefined {
  return object.properties.find(
    (property): property is PlainProperty =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      property.name.text === key,
  );
}

// `repo.find(...)` or `prisma.model.findMany(...)`, awaited or not, as a whole statement's value.
export function queryCall(expression: Expression): MethodCall | undefined {
  const value = unwrap(expression);
  const call = ts.isAwaitExpression(value) ? unwrap(value.expression) : value;
  if (isMethodCall(call)) return call;
}

export function hasModifier(declaration: Node, kind: SyntaxKind): boolean {
  return ts.canHaveModifiers(declaration) && !!ts.getModifiers(declaration)?.some((modifier) => modifier.kind === kind);
}

export function lastSegment(qualifiedName: string): string {
  const segments = qualifiedName.split('.');
  return segments[segments.length - 1];
}
