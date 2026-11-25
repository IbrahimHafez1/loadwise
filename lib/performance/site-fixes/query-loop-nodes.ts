// AST helpers shared by the per-item query rewrites: node search, text splicing, what a loop body
// reads or writes, and object literal properties.
import { ts, textOf, lineStart } from './helpers.js';
import type {
  Expression,
  Identifier,
  Node,
  NoSubstitutionTemplateLiteral,
  ObjectLiteralElementLike,
  StringLiteral,
} from 'typescript';
import type { PlainProperty } from '../types/plain-property.js';
import type { TextEdit } from '../../shared/types.js';

export function someNode(root: Node, predicate: (node: Node) => unknown): boolean {
  return !!(function visit(node: Node): unknown {
    return predicate(node) || ts.forEachChild(node, visit);
  })(root);
}

export function outerParentheses(expression: Expression): Expression {
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return expression;
}

export function startsLine(node: Node): boolean {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  return !sourceFile.text.slice(lineStart(sourceFile.text, start), start).trim();
}

// The text of `node` with absolute-offset edits inside it applied.
export function textWith(node: Node, edits: TextEdit[]): string {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  let result = textOf(node);
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start - start) + edit.text + result.slice(edit.end - start);
  }
  return result;
}

// Wraps a replacement in parentheses unless the slot it lands in already separates it from its
// neighbours.
export function inSlot(target: Expression, text: string): string {
  const parent = target.parent;
  const bare =
    (ts.isVariableDeclaration(parent) && parent.initializer === target) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === target) ||
    ts.isReturnStatement(parent) ||
    ts.isExpressionStatement(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
    (ts.isCallExpression(parent) && parent.arguments.includes(target));
  return bare ? text : `(${text})`;
}

export function isReference(identifier: Identifier): boolean {
  const parent = identifier.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === identifier)
    return false;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false;
  return !ts.isTypeReferenceNode(parent) && !ts.isQualifiedName(parent);
}

function mutationTarget(node: Node): Expression | undefined {
  if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) return node.left;
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return node.operand;
  if (ts.isDeleteExpression(node)) return node.expression;
}

// Names declared or written inside `root`; an expression reading them cannot be evaluated before
// the loop.
export function localNames(root: Node): Set<string> {
  const names = new Set<string>();
  someNode(root, (node: Node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text);
    const target = mutationTarget(node);
    if (target)
      someNode(target, (inner) => {
        if (ts.isIdentifier(inner)) names.add(inner.text);
      });
    return false;
  });
  return names;
}

// Whether `expression` reads only the loop variable and bindings the loop never declares or writes.
export function readsOnly(
  expression: Expression,
  loopVariable: string,
  locals: ReadonlySet<string>,
): { usesLoopVariable: boolean } | undefined {
  let usesLoopVariable = false;
  const unsafe = someNode(expression, (node: Node) => {
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isFunctionLike(node) || mutationTarget(node))
      return true;
    if (!ts.isIdentifier(node) || !isReference(node)) return false;
    if (node.text === loopVariable) usesLoopVariable = true;
    else if (locals.has(node.text)) return true;
    return false;
  });
  return unsafe ? undefined : { usesLoopVariable };
}

export function receiverRoot(expression: Expression): string | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) && current.expression.kind !== ts.SyntaxKind.ThisKeyword)
    current = current.expression;
  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) return textOf(current);
}

export function mentions(text: string, name: string): boolean {
  // Over-matching `item.name` only keeps a parameter; missing `...name` would drop one the result
  // reads.
  return new RegExp(`(?<![\\w$])${name.replaceAll('$', '\\$')}(?![\\w$])`).test(text);
}

export function readsOnlyNames(
  expression: Expression,
  names: ReadonlySet<string>,
  locals: ReadonlySet<string>,
): { usesLoopVariable: boolean } | undefined {
  let usesLoopVariable = false;
  const unsafe = someNode(expression, (node: Node) => {
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isFunctionLike(node) || mutationTarget(node))
      return true;
    if (!ts.isIdentifier(node) || !isReference(node)) return false;
    if (names.has(node.text)) usesLoopVariable = true;
    else if (locals.has(node.text)) return true;
    return false;
  });
  return unsafe ? undefined : { usesLoopVariable };
}

function propertyName(property: ObjectLiteralElementLike): string | undefined {
  if (!property.name || ts.isComputedPropertyName(property.name)) return;
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) return property.name.text;
}

// Property assignments by name, or undefined when spreads, methods, computed or repeated names hide
// the shape.
export function plainProperties(object: Expression | undefined): Map<string, PlainProperty> | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  const properties = new Map<string, PlainProperty>();
  for (const property of object.properties) {
    const name = propertyName(property);
    if (
      name === undefined ||
      properties.has(name) ||
      !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    )
      return;
    properties.set(name, property);
  }
  return properties;
}

export function propertyValue(property: PlainProperty): Expression {
  return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
}

export function indentationOf(node: Node): string {
  const sourceFile = node.getSourceFile();
  const start = lineStart(sourceFile.text, node.getStart(sourceFile));
  return /^[ \t]*/.exec(sourceFile.text.slice(start))?.[0] ?? '';
}

export function singleLineLiteral(node: Node): node is StringLiteral | NoSubstitutionTemplateLiteral {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false;
  const raw = textOf(node);
  return raw.slice(1, -1) === node.text && !node.text.includes('\n');
}
