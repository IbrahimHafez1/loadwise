// Syntax helpers shared by the exposure rules: option objects, literal values and call shapes.
import { ts } from '../../performance/compiler.js';
import type {
  CallExpression,
  Expression,
  Identifier,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  ShorthandPropertyAssignment,
} from 'typescript';
import type { CheckerAdapter } from '../../shared/types.js';

function unwrap(expression: Expression): Expression;
function unwrap(expression: Expression | undefined): Expression | undefined;
function unwrap(expression: Expression | undefined): Expression | undefined {
  return expression && ts.skipOuterExpressions(expression);
}

function nameText(name: Node): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

// The object literal an options expression stands for: itself, or a `const` that holds one.
function objectLiteralOf(
  expression: Expression | undefined,
  checker: CheckerAdapter,
): ObjectLiteralExpression | undefined {
  const node = unwrap(expression);
  if (!node) return;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (!ts.isIdentifier(node)) return;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
    return;
  const initializer = unwrap(declaration.initializer);
  return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
}

export interface FoundProperty {
  property: PropertyAssignment | ShorthandPropertyAssignment;
  value: Expression | Identifier;
}

// { property, value } for the member `name` of an object literal; value is the unwrapped
// initializer.
function findProperty(literal: ObjectLiteralExpression, name: string): FoundProperty | undefined {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && nameText(property.name) === name)
      return { property, value: unwrap(property.initializer) };
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name)
      return { property, value: property.name };
  }
}

// A spread or computed key means the literal does not state every option, so a missing one proves
// nothing.
function isFullyLiteral(literal: ObjectLiteralExpression): boolean {
  return literal.properties.every(
    (property) => !ts.isSpreadAssignment(property) && !(property.name && ts.isComputedPropertyName(property.name)),
  );
}

function isTrue(node: Node | undefined) {
  return node?.kind === ts.SyntaxKind.TrueKeyword;
}

function isFalse(node: Node | undefined) {
  return node?.kind === ts.SyntaxKind.FalseKeyword;
}

// `res.status(500).json(...)` -> `res`; undefined when the chain does not start at a plain
// identifier.
function chainRootName(expression: Expression) {
  let node = unwrap(expression);
  while (
    node &&
    (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node))
  )
    node = unwrap(node.expression);
  return node && ts.isIdentifier(node) ? node.text : undefined;
}

// The called method name of `receiver.method(...)`.
function methodName(call: CallExpression) {
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

const nonProductionWhenTrue = [
  /NODE_ENV\s*(?:!==|!=)\s*['"]production['"]/,
  /NODE_ENV\s*(?:===|==)\s*['"](?:development|dev|local|test)['"]/,
  /(?<!!)\b(?:isDev|isDevelopment|isLocal|isTest)\b/,
  /!\s*(?:isProd|isProduction)\b/,
];
const nonProductionWhenFalse = [
  /NODE_ENV\s*(?:===|==)\s*['"]production['"]/,
  /(?<!!)\b(?:isProd|isProduction)\b/,
  /!\s*(?:isDev|isDevelopment|isLocal|isTest)\b/,
];

function matchesAny(patterns: readonly RegExp[], text: string) {
  return patterns.some((pattern) => pattern.test(text));
}

// The conditions `node` runs under inside its function: `{ condition, branch }` for each enclosing
// if, ternary or
// `&&`, innermost first, where branch is 'true' or 'false'.
export interface EnclosingBranch {
  condition: Expression;
  branch: 'true' | 'false';
}

function* enclosingBranches(node: Node): Generator<EnclosingBranch> {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return;
    let condition: Expression | undefined;
    let branch: 'true' | 'false' | undefined;
    if (ts.isIfStatement(parent)) {
      condition = parent.expression;
      branch = child === parent.thenStatement ? 'true' : child === parent.elseStatement ? 'false' : undefined;
    } else if (ts.isConditionalExpression(parent)) {
      condition = parent.condition;
      branch = child === parent.whenTrue ? 'true' : child === parent.whenFalse ? 'false' : undefined;
    } else if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      condition = parent.left;
      branch = child === parent.right ? 'true' : undefined;
    }
    if (branch && condition) yield { condition, branch };
  }
}

// True when `node` only runs outside production: inside the right branch of an environment check.
function underNonProductionGuard(node: Node) {
  for (const { condition, branch } of enclosingBranches(node))
    if (matchesAny(branch === 'true' ? nonProductionWhenTrue : nonProductionWhenFalse, condition.getText()))
      return true;
  return false;
}

export {
  unwrap,
  nameText,
  objectLiteralOf,
  findProperty,
  isFullyLiteral,
  isTrue,
  isFalse,
  chainRootName,
  methodName,
  enclosingBranches,
  underNonProductionGuard,
};
