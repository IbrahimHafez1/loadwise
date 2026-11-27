// Translates the JSX of a TypeScript or JavaScript source file into the element model.
import { ts } from '../performance/compiler.js';
import type {
  Expression,
  JsxAttribute,
  JsxAttributeLike,
  JsxElement,
  JsxSelfClosingElement,
  Node,
  SourceFile,
} from 'typescript';
import { intrinsicTagPattern } from './markup.js';
import type { MarkupAttribute, MarkupAttributeValue, MarkupDocument, MarkupElement } from './markup.js';

const htmlNameByJsxProp: Readonly<Record<string, string>> = { htmlFor: 'for', className: 'class' };

type JsxElementNode = JsxElement | JsxSelfClosingElement;

function isElementNode(node: Node): node is JsxElementNode {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function htmlAttributeName(jsxName: string): string {
  return htmlNameByJsxProp[jsxName] ?? jsxName.toLowerCase();
}

function unwrapExpression(expression: Expression): Expression {
  return ts.isParenthesizedExpression(expression) ? unwrapExpression(expression.expression) : expression;
}

function staticExpressionText(expression: Expression): string | undefined {
  const inner = unwrapExpression(expression);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) || ts.isNumericLiteral(inner)) {
    return inner.text;
  }
  const isNegatedNumber =
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand);
  return isNegatedNumber ? `-${inner.operand.text}` : undefined;
}

function attributeValue(attribute: JsxAttribute): MarkupAttributeValue {
  const initializer = attribute.initializer;
  if (!initializer) return { kind: 'static', text: '' };
  if (ts.isStringLiteral(initializer)) return { kind: 'static', text: initializer.text };
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return { kind: 'dynamic' };
  const text = staticExpressionText(initializer.expression);
  return text === undefined ? { kind: 'dynamic' } : { kind: 'static', text };
}

const propagationOnlyCalls: ReadonlySet<string> = new Set(['stopPropagation', 'preventDefault']);

function isPropagationOnlyCall(statement: Node): boolean {
  if (!ts.isExpressionStatement(statement) && !ts.isCallExpression(statement)) return false;
  const call = ts.isExpressionStatement(statement) ? statement.expression : statement;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    propagationOnlyCalls.has(call.expression.name.text)
  );
}

// `onClick={(event) => event.stopPropagation()}` keeps a click inside a panel from reaching a backdrop, and an empty
// `onClick={() => {}}` does nothing; neither is a way to activate the element, so both are left out of the model like a
// missing handler.
function isPropagationOnlyHandler(attribute: JsxAttribute): boolean {
  const initializer = attribute.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) return false;
  const handler = unwrapExpression(initializer.expression);
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return false;
  if (!ts.isBlock(handler.body)) return isPropagationOnlyCall(handler.body);
  const { statements } = handler.body;
  return statements.every(isPropagationOnlyCall);
}

function position(sourceFile: SourceFile, node: Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function translateAttributes(
  sourceFile: SourceFile,
  attributeNodes: readonly JsxAttributeLike[],
): { attributes: MarkupAttribute[]; hasSpreadAttributes: boolean } {
  const attributes: MarkupAttribute[] = [];
  let hasSpreadAttributes = false;
  for (const attribute of attributeNodes) {
    if (!ts.isJsxAttribute(attribute)) {
      hasSpreadAttributes = true;
      continue;
    }
    const name = htmlAttributeName(attribute.name.getText(sourceFile));
    if (name === 'onclick' && isPropagationOnlyHandler(attribute)) continue;
    attributes.push({ name, value: attributeValue(attribute), ...position(sourceFile, attribute.name) });
  }
  return { attributes, hasSpreadAttributes };
}

function translateElement(sourceFile: SourceFile, node: JsxElementNode): MarkupElement {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const children = ts.isJsxElement(node) ? node.children : [];
  const tagName = opening.tagName.getText(sourceFile);
  const { attributes, hasSpreadAttributes } = translateAttributes(sourceFile, opening.attributes.properties);
  const nested: MarkupElement[] = [];
  for (const attribute of opening.attributes.properties) collectElements(sourceFile, attribute, nested);
  for (const child of children) collectElements(sourceFile, child, nested);
  return {
    tagName,
    isIntrinsic: intrinsicTagPattern.test(tagName),
    attributes,
    hasSpreadAttributes,
    children: nested,
    ...position(sourceFile, opening),
  };
}

// Fragments and expression wrappers are transparent: the elements inside them belong to the nearest enclosing element.
function collectElements(sourceFile: SourceFile, node: Node, into: MarkupElement[]): void {
  if (isElementNode(node)) {
    into.push(translateElement(sourceFile, node));
    return;
  }
  ts.forEachChild(node, (child) => collectElements(sourceFile, child, into));
}

function jsxDocument(sourceFile: SourceFile, file: string): MarkupDocument {
  const roots: MarkupElement[] = [];
  collectElements(sourceFile, sourceFile, roots);
  return { file, roots, text: sourceFile.text };
}

export { jsxDocument };
