import { ts } from './helpers.js';
import { bindingList, contains, isIncrement, symbolOf } from './extract-block-ast.js';
import type { Node, Statement, Symbol, Type, TypeChecker } from 'typescript';
import type { FreeVariable } from '../types/extract-block.js';

// `a.b?.c!` and `a["b"]` as the path TypeScript narrows: `a.b.c`, `a.b`. Undefined for anything
// else.
function referencePath(node: Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return referencePath(node.expression);
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
  const owner = referencePath(node.expression);
  if (!owner) return;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return owner + '.' + node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return owner + '.' + node.argumentExpression.text;
  // TypeScript also narrows `a[key]` for a constant key.
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.argumentExpression))
    return owner + '[' + node.argumentExpression.text + ']';
}

function isPathNode(node: Node): boolean {
  return (
    ts.isIdentifier(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  );
}

// Paths under `root`. A called function is not narrowed by the call, so callees are left out.
function addPaths(root: Node, paths: Set<string>): void {
  (function walk(node: Node): void {
    const callee = ts.isCallExpression(node.parent) && node.parent.expression === node;
    if (isPathNode(node) && !callee) {
      const found = referencePath(node);
      if (found) paths.add(found);
    }
    ts.forEachChild(node, walk);
  })(root);
}

// Expressions whose paths TypeScript may narrow for the code after them.
function narrowingParts(node: Node): readonly (Node | undefined)[] {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) return [node.expression];
  if (ts.isSwitchStatement(node)) return [node.expression];
  if (ts.isForStatement(node)) return [node.condition];
  if (ts.isConditionalExpression(node)) return [node.condition];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (ts.isAssignmentOperator(operator)) return [node.left];
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    )
      return [node.left];
  }
  if (ts.isCallExpression(node) && /^assert/i.test(referencePath(node.expression)?.split('.').at(-1) ?? ''))
    return node.arguments;
  if (isIncrement(node)) return [node.operand];
  // A declared union narrows to the type of its initializer.
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) return [node.name];
  return [];
}

// Paths of `fn` outside `statement` that a condition, assertion or assignment may narrow.
function narrowedPaths(fn: Node, statement: Statement): Set<string> {
  const paths = new Set<string>();
  (function walk(node: Node): void {
    if (node === statement) return;
    for (const part of narrowingParts(node)) if (part) addPaths(part, paths);
    ts.forEachChild(node, walk);
  })(fn);
  return paths;
}

// A type narrowing cannot change: known, and neither a union nor any/unknown (which unresolved
// imports become).
function plainType(type: Type): boolean {
  return !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) && !type.isUnion();
}

function constantSymbol(symbol: Symbol): boolean {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return false;
  if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
    const list = bindingList(declaration);
    return Boolean(list && ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const);
  }
  return (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration)
  );
}

// TypeScript narrows outer paths for the code inside them; a separate function sees only declared
// types. The parameters carry the narrowed type of each variable, but paths through properties and
// module bindings lose it.
export function narrowingLost(
  statement: Statement,
  fn: Node,
  checker: TypeChecker,
  variables: readonly FreeVariable[],
  builtDeclaration: Node | undefined,
): boolean {
  const narrowed = narrowedPaths(fn, statement);
  const parameters = new Set(variables.map((variable) => variable.symbol));
  let lost = false;
  (function walk(node: Node): void {
    if (lost) return;
    const path = isPathNode(node) && referencePath(node);
    if (path && narrowed.has(path) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      if (ts.isIdentifier(node)) {
        const symbol = symbolOf(checker, node);
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        if (!symbol) lost = true;
        // The parameter type is read at this spot, so it is narrowed already, unless it is unknown here.
        else if (parameters.has(symbol)) lost = Boolean(checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any);
        else if (declaration && (contains(statement, declaration) || declaration === builtDeclaration)) lost = false;
        else
          lost = !(
            plainType(checker.getTypeOfSymbol(symbol)) ||
            (declaration !== undefined &&
              constantSymbol(symbol) &&
              !ts.isVariableDeclaration(declaration) &&
              !ts.isBindingElement(declaration))
          );
      } else if (path.includes('.') || path.includes('[')) {
        const property = ts.isPropertyAccessExpression(node) && checker.getSymbolAtLocation(node.name);
        if (!property || !plainType(checker.getTypeOfSymbol(property))) lost = true;
      }
    }
    ts.forEachChild(node, walk);
  })(statement);
  return lost;
}
