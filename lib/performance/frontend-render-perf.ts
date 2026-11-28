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
// Only an array of string and number literals keeps its identities; objects, calls and spreads do not.
const LITERAL_ITEM = String.raw`(?:'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?)`;
const STATIC_ARRAY_SOURCE = new RegExp(String.raw`\bof\s+\[\s*(?:${LITERAL_ITEM}\s*(?:,\s*${LITERAL_ITEM}\s*)*)?\]`);
// A `trackBy` binding in the microsyntax (`trackBy: fn` or `trackBy fn`), not a property or variable of that name.
const TRACK_BY = /(?<![.\w$])trackBy(?:\s*:|\s+[\w$])/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const REACT_COMPONENT_WRAPPERS = new Set(['memo', 'forwardRef']);
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
  if (ts.isVariableDeclaration(parent) && parent.initializer === fn) return parent;
  return wrappingVariable(fn);
}

function declaredName(fn: FunctionNode): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  const parent = fn.parent;
  const variable = ts.isVariableDeclaration(parent) && parent.initializer === fn ? parent : wrappingVariable(fn);
  return variable && ts.isIdentifier(variable.name) ? variable.name.text : undefined;
}

// The variable initialised with `memo(fn)` or `forwardRef(fn)`; React documents both as returning a new component.
function wrappingVariable(fn: FunctionNode) {
  const wrapper = fn.parent;
  if (!ts.isCallExpression(wrapper) || wrapper.arguments[0] !== fn) return;
  const callee = ts.isPropertyAccessExpression(wrapper.expression) ? wrapper.expression.name : wrapper.expression;
  if (!ts.isIdentifier(callee) || !REACT_COMPONENT_WRAPPERS.has(callee.text)) return;
  const variable = wrapper.parent;
  return ts.isVariableDeclaration(variable) && variable.initializer === wrapper ? variable : undefined;
}

function isJsx(expression: Expression): boolean {
  const target = ts.skipOuterExpressions(expression);
  if (ts.isJsxElement(target) || ts.isJsxSelfClosingElement(target) || ts.isJsxFragment(target)) return true;
  if (ts.isConditionalExpression(target)) return isJsx(target.whenTrue) || isJsx(target.whenFalse);
  if (ts.isArrayLiteralExpression(target)) return target.elements.some(isJsx);
  // `items.map(() => <Row />)`: a callback argument that itself returns JSX.
  if (ts.isCallExpression(target)) {
    return target.arguments.some((argument) => isFunctionNode(argument) && returnsJsx(argument));
  }
  if (!ts.isBinaryExpression(target)) return false;
  const operator = target.operatorToken.kind;
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return isJsx(target.right);
  return (
    (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) &&
    (isJsx(target.left) || isJsx(target.right))
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
  const name = declaredName(fn);
  return name !== undefined && COMPONENT_NAME.test(name);
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
  // Angular drops HTML comments, so a commented-out loop renders nothing.
  for (const match of template.replaceAll(HTML_COMMENT, '').matchAll(NG_FOR_ATTRIBUTE)) {
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

// A `templateUrl` is relative to its component; an absolute or UNC path would make the scan read an
// arbitrary location, including a network share.
function externalTemplate(property: PropertyAssignment, sourceFileName: string) {
  const url = stringValueOf(property.initializer);
  if (!url || !HTML_FILE.test(url) || path.isAbsolute(url) || path.win32.isAbsolute(url)) return;
  const text = ts.sys.readFile(path.resolve(path.dirname(sourceFileName), url));
  return text === undefined ? undefined : { url, text };
}

function reportUntracked(
  property: PropertyAssignment,
  loops: string[],
  context: PerformanceRuleContext,
  templateUrl?: string,
) {
  const more = loops.length > 1 ? ` (and ${loops.length - 1} more in this template)` : '';
  const location = templateUrl ? ` in \`${templateUrl}\`` : '';
  const loop = loops[0].replaceAll(CONTROL_CHARACTERS, ' ');
  context.report(
    property,
    'angular-ngfor-missing-trackby',
    `\`*ngFor="${loop}"\`${location}${more} has no \`trackBy\`, so when the list is replaced with new objects Angular destroys and recreates the DOM for every item instead of moving the ones that stayed. Add \`trackBy: trackById\` with a function returning a stable identifier, or migrate to \`@for (... ; track item.id)\`.`,
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
  const template = external && externalTemplate(external, metadata.getSourceFile().fileName);
  if (!external || !template) return;
  const loops = untrackedLoops(template.text);
  if (loops.length) reportUntracked(external, loops, context, template.url);
}

export { checkComponentInComponent, checkNgForTrackBy, isFunctionNode };
