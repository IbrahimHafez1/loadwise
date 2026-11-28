// Frontend render-cost rules that read the shape of a component rather than one call:
// - react-component-defined-in-component
// - angular-ngfor-missing-trackby
import path from 'node:path';
import { ts } from './compiler.js';
import { propertyName } from './schema/ts-helpers.js';
import { walkAll, walkSkippingFunctions } from './frontend-helpers.js';
import type {
  ArrowFunction,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
} from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';

type FunctionNode = FunctionDeclaration | ArrowFunction | FunctionExpression;

const COMPONENT_NAME = /^[A-Z]/;
// `*ngFor="let item of items; trackBy: byId"`, in either quote style; the expression never contains its own quote.
const NG_FOR_ATTRIBUTE = /\*ngFor\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const STATIC_ARRAY_SOURCE = /\bof\s+\[/;
const TRACK_BY = /\btrackBy\b/;
const HTML_FILE = /\.html?$/i;

// --- React: component defined inside a component
// ------------------------------------------------------------------------------

function isFunctionNode(node: Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

// The function declaration itself, or the variable it initialises: the node the checker reports as
// the declaration of the component's name.
function declarationOf(fn: FunctionNode): Node | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name ? fn : undefined;
  const parent = fn.parent;
  return ts.isVariableDeclaration(parent) && parent.initializer === fn ? parent : undefined;
}

function declaredName(fn: FunctionNode): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  const parent = fn.parent;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== fn) return;
  return ts.isIdentifier(parent.name) ? parent.name.text : undefined;
}

function isJsx(expression: Expression): boolean {
  const target = ts.skipOuterExpressions(expression);
  if (ts.isJsxElement(target) || ts.isJsxSelfClosingElement(target) || ts.isJsxFragment(target)) return true;
  if (ts.isConditionalExpression(target)) return isJsx(target.whenTrue) || isJsx(target.whenFalse);
  return (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    isJsx(target.right)
  );
}

function returnsJsx(fn: FunctionNode): boolean {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return isJsx(fn.body);
  let found = false;
  walkSkippingFunctions(fn.body, (node: Node) => {
    if (ts.isReturnStatement(node) && node.expression && isJsx(node.expression)) found = true;
  });
  return found;
}

// `function Row() {}`, `const Row = () => ...`, `const Row = memo(() => ...)` / `forwardRef(...)`.
function isComponent(fn: FunctionNode): boolean {
  const direct = declaredName(fn);
  if (direct) return COMPONENT_NAME.test(direct);
  const wrapper = fn.parent;
  if (!ts.isCallExpression(wrapper) || wrapper.arguments[0] !== fn) return false;
  const variable = wrapper.parent;
  return (
    ts.isVariableDeclaration(variable) && ts.isIdentifier(variable.name) && COMPONENT_NAME.test(variable.name.text)
  );
}

// Only the nearest function counts: a component declared inside a callback of the outer component
// is not matched, which keeps render-prop shapes out.
function enclosingFunction(node: Node): FunctionNode | undefined {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionNode(current)) return current;
    if (ts.isClassLike(current)) return;
    current = current.parent;
  }
}

// Whether the outer component renders `<Inner />` where the tag resolves to this very declaration.
function rendersAsElement(outer: FunctionNode, declaration: Node, name: string, context: PerformanceRuleContext) {
  let rendered = false;
  walkAll(outer, (node: Node) => {
    if (rendered || !(ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) return;
    if (!ts.isIdentifier(node.tagName) || node.tagName.text !== name) return;
    const declarations = context.checker.getSymbolAtLocation(node.tagName)?.declarations;
    rendered = Boolean(declarations?.includes(declaration));
  });
  return rendered;
}

function checkComponentInComponent(fn: FunctionNode, context: PerformanceRuleContext) {
  const name = declaredName(fn);
  const declaration = declarationOf(fn);
  if (!name || !declaration || !COMPONENT_NAME.test(name) || !returnsJsx(fn)) return;
  const outer = enclosingFunction(fn);
  if (!outer || !isComponent(outer) || !returnsJsx(outer)) return;
  if (!rendersAsElement(outer, declaration, name, context)) return;
  context.report(
    declaration,
    'react-component-defined-in-component',
    `\`${name}\` is a component declared inside another component and rendered as \`<${name} />\`. It is a new component type on every render, so React unmounts and remounts its whole subtree each time, losing state and DOM. Move it to module scope and pass what it needs as props.`,
  );
}

// --- Angular: *ngFor without trackBy
// ------------------------------------------------------------------------------

// Interpolated parts of a template literal cannot hide an `*ngFor` attribute, so they are dropped.
function stringValueOf(initializer: Expression): string | undefined {
  const target = ts.skipOuterExpressions(initializer);
  if (ts.isStringLiteralLike(target)) return target.text;
  if (ts.isTemplateExpression(target)) {
    return [target.head.text, ...target.templateSpans.map((span) => span.literal.text)].join(' ');
  }
}

// The `*ngFor` expressions that name no trackBy. A loop over a literal array never reorders, so it
// costs nothing.
function untrackedLoops(template: string): string[] {
  const loops: string[] = [];
  for (const match of template.matchAll(NG_FOR_ATTRIBUTE)) {
    const expression = match[1] ?? match[2];
    if (!TRACK_BY.test(expression) && !STATIC_ARRAY_SOURCE.test(expression)) loops.push(expression.trim());
  }
  return loops;
}

function metadataProperty(metadata: ObjectLiteralExpression, name: string): PropertyAssignment | undefined {
  return metadata.properties.find(
    (property): property is PropertyAssignment => ts.isPropertyAssignment(property) && propertyName(property) === name,
  );
}

function externalTemplateText(property: PropertyAssignment, sourceFileName: string): string | undefined {
  const url = stringValueOf(property.initializer);
  if (!url || !HTML_FILE.test(url)) return;
  return ts.sys.readFile(path.resolve(path.dirname(sourceFileName), url));
}

function reportUntracked(property: PropertyAssignment, loops: string[], context: PerformanceRuleContext) {
  const more = loops.length > 1 ? ` (and ${loops.length - 1} more in this template)` : '';
  context.report(
    property,
    'angular-ngfor-missing-trackby',
    `\`*ngFor="${loops[0]}"\`${more} has no \`trackBy\`, so when the list changes Angular destroys and recreates the DOM for every item instead of moving the ones that stayed. Add \`trackBy: trackById\` with a function returning a stable identifier, or migrate to \`@for (... ; track item.id)\`.`,
  );
}

function checkNgForTrackBy(metadata: ObjectLiteralExpression, context: PerformanceRuleContext) {
  const inline = metadataProperty(metadata, 'template');
  const inlineText = inline && stringValueOf(inline.initializer);
  if (inline && inlineText) {
    const loops = untrackedLoops(inlineText);
    if (loops.length) reportUntracked(inline, loops, context);
  }
  const external = metadataProperty(metadata, 'templateUrl');
  const externalText = external && externalTemplateText(external, metadata.getSourceFile().fileName);
  if (!external || !externalText) return;
  const loops = untrackedLoops(externalText);
  if (loops.length) reportUntracked(external, loops, context);
}

export { checkComponentInComponent, checkNgForTrackBy, isFunctionNode };
