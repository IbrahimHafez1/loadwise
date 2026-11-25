// Helpers the auth and crypto rules share: library function names, constant resolution and name
// matching.
import { ts } from '../../performance/compiler.js';
import type {
  CallExpression,
  Expression,
  Identifier,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  SignatureDeclaration,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, LibraryCall, SecurityRuleContext } from '../../shared/types.js';

const constantDepthLimit = 3;
const mentionCache = new WeakMap<SourceFile, Map<string, boolean>>();

// A cheap per-file gate: most files never mention the library, so their calls need no resolution.
function fileMentions(sourceFile: SourceFile, fragments: readonly string[]) {
  let cached = mentionCache.get(sourceFile);
  if (!cached) mentionCache.set(sourceFile, (cached = new Map<string, boolean>()));
  const key = fragments.join('|');
  if (!cached.has(key))
    cached.set(
      key,
      fragments.some((fragment) => sourceFile.text.includes(fragment)),
    );
  return cached.get(key);
}

const callInfoCache = new WeakMap<CallExpression, LibraryCall | undefined>();

// context.libraryCall resolves types, so each call is resolved once for every rule that asks.
function libraryInfo(call: CallExpression, context: SecurityRuleContext) {
  if (!callInfoCache.has(call)) callInfoCache.set(call, context.libraryCall(call));
  return callInfoCache.get(call);
}

// The name of the library function a call reaches (`verify` for `jwt.verify()` and for `verify()`
// imported from jsonwebtoken), or undefined when the call is not into one of `modules`.
function libraryFunction(call: CallExpression, context: SecurityRuleContext, modules: readonly string[]) {
  const info = libraryInfo(call, context);
  if (!info?.module || !modules.includes(info.module)) return;
  const name = info.method ?? info.exported;
  return name === 'default' ? undefined : name;
}

// Follows `const x = <expression>` chains in the same program to the expression that defines the
// value.
function resolveConstant(expression: Expression, checker: CheckerAdapter, depth = 0): Expression {
  const node = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(node) || depth > constantDepthLimit) return node;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  const isConstant =
    declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const;
  return isConstant && declaration.initializer ? resolveConstant(declaration.initializer, checker, depth + 1) : node;
}

function propertyKeyName(nameNode: Node | undefined): string | undefined {
  if (!nameNode) return;
  if (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode)) return nameNode.text;
}

// `secret` for `config.secret`, `config['secret']` and `secret`.
function lastSegment(node: Node) {
  const expression = ts.skipOuterExpressions(node);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression))
    return expression.argumentExpression.text;
}

function findProperty(objectLiteral: ObjectLiteralExpression, name: string) {
  return objectLiteral.properties.find(
    (property): property is PropertyAssignment | ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyKeyName(property.name) === name,
  );
}

function hasSpread(objectLiteral: ObjectLiteralExpression) {
  return objectLiteral.properties.some((property) => ts.isSpreadAssignment(property));
}

// `userPassword` -> ['user', 'password']; `JWT_SECRET` -> ['jwt', 'secret']; `OTPCode` -> ['otp',
// 'code'].
function nameWords(name: string): string[] {
  return name
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function enclosingFunction(node: Node) {
  return ts.findAncestor(node.parent, ts.isFunctionLike);
}

// The name a function is declared or assigned under: `generateToken`, `const generateToken = () =>
// ...`, a method.
function functionName(fn: SignatureDeclaration): string | undefined {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteralLike(fn.name))) return fn.name.text;
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)))
    return propertyKeyName(parent.name);
}

// Every other identifier under `scope` that resolves to the same symbol as `identifier`.
function referencesOf(identifier: Identifier, scope: Node, checker: CheckerAdapter): Identifier[] {
  const symbol = checker.getSymbolAtLocation(identifier);
  const references: Identifier[] = [];
  (function visit(node: Node): void {
    if (
      ts.isIdentifier(node) &&
      node !== identifier &&
      node.text === identifier.text &&
      checker.getSymbolAtLocation(node) === symbol
    )
      references.push(node);
    ts.forEachChild(node, visit);
  })(scope);
  return references;
}

function isFunctionExpressionLike(node: Node) {
  const expression = ts.skipOuterExpressions(node);
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

export {
  fileMentions,
  libraryInfo,
  libraryFunction,
  resolveConstant,
  propertyKeyName,
  lastSegment,
  findProperty,
  hasSpread,
  nameWords,
  enclosingFunction,
  functionName,
  referencesOf,
  isFunctionExpressionLike,
};
