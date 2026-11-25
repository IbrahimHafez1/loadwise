import { loadSyntax } from './compiler.cjs';
import { outerExpression } from './repeated.cjs';
import type { Expression, Node, SyntaxKind } from 'typescript';
import type { CheckerAdapter } from '../shared/types.cjs';
import type { QueryCall } from './types/query-loops.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
const ts = loadSyntax();

function sameText(left: Node, right: Node) {
  return left.getText().replaceAll(/\s+/g, '') === right.getText().replaceAll(/\s+/g, '');
}

function isNullish(node: Node) {
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}

// The caches a `!hit` or `!cache.has(key)` miss test reads, or with `hit` set the caches a `hit`,
// `cache.has(key)` or `hit !== undefined` hit test reads: `hit` comes from `cache.get(key)`,
// `cache[key]`, or a lookup call that receives the cache, such as `findByName(cached, name)` or
// `cached.find(...)`.
function testedCaches(condition: Expression, checker: CheckerAdapter, hit = false): Expression[] {
  const equality: SyntaxKind[] = hit
    ? [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]
    : [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];
  let value = ts.skipOuterExpressions(condition);
  if (!hit && ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken)
    value = ts.skipOuterExpressions(value.operand);
  else if (ts.isBinaryExpression(value) && equality.includes(value.operatorToken.kind) && isNullish(value.right))
    value = ts.skipOuterExpressions(value.left);
  else if (!hit) return [];
  if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression))
    return value.expression.name.text === 'has' ? [value.expression.expression] : [];
  if (!ts.isIdentifier(value)) return [];
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return [];
  const initializer = ts.skipOuterExpressions(declaration.initializer);
  if (ts.isElementAccessExpression(initializer)) return [initializer.expression];
  if (!ts.isCallExpression(initializer)) return [];
  const receiver = ts.isPropertyAccessExpression(initializer.expression) ? [initializer.expression.expression] : [];
  return [...receiver, ...initializer.arguments.filter((argument: Expression) => ts.isIdentifier(argument))];
}

// The miss branch writes the loaded value back with `cache.set`, `cache.push` or `cache[key] =`.
function storesInto(statement: Node, cache: Node) {
  return !!(function visit(node: Node): true | undefined {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'set' || node.expression.name.text === 'push') &&
      sameText(node.expression.expression, cache)
    )
      return true;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      sameText(node.left.expression, cache)
    )
      return true;
    return ts.forEachChild(node, visit);
  })(statement);
}

// `cache ??= await load()` and a lookup that loads only on a miss and stores the result run once
// per distinct key.
function isMemoised(call: QueryCall, checker: CheckerAdapter, owner?: RepeatOwner) {
  let expression = outerExpression(call);
  if (ts.isAwaitExpression(expression.parent)) expression = outerExpression(expression.parent);
  const assignment = expression.parent;
  if (
    ts.isBinaryExpression(assignment) &&
    assignment.right === expression &&
    (assignment.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      assignment.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken)
  )
    return true;
  // A miss test outside the loop guards the whole loop, which still queries once per item.
  for (
    let current: Node = call;
    current !== owner && current.parent && !ts.isFunctionLike(current.parent);
    current = current.parent
  ) {
    const parent = current.parent;
    if (!ts.isIfStatement(parent)) continue;
    // `if (!cache.has(key)) { load; store }` or `if (cache.has(key)) { use } else { load; store }`.
    const onHit = parent.elseStatement === current;
    if (!onHit && parent.thenStatement !== current) continue;
    if (testedCaches(parent.expression, checker, onHit).some((cache) => storesInto(current, cache))) return true;
  }
  return false;
}

export { isMemoised };
