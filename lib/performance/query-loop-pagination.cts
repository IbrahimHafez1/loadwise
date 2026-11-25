import { loadSyntax } from './compiler.cjs';
import { exitsLoop } from './query-loop-exits.cjs';
import { fixedBatchSize, localInitializer, readProperty, sameBinding } from './query-loop-helpers.cjs';
import type { Expression, Identifier, Node } from 'typescript';
import type { CheckerAdapter } from '../shared/types.cjs';
import type { PageScan, QueryCall } from './types/query-loops.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
const ts = loadSyntax();

function isPageScan(loop: Node): loop is PageScan {
  return (
    (ts.isWhileStatement(loop) && loop.expression.kind === ts.SyntaxKind.TrueKeyword) ||
    (ts.isForStatement(loop) && !loop.initializer && !loop.condition && !loop.incrementor)
  );
}

// A short final page ends this scan. The rows used for a set query must be the same collection.
function hasShortPageExit(rows: Identifier, owner: PageScan, checker: CheckerAdapter) {
  return (
    ts.isBlock(owner.statement) &&
    owner.statement.statements.some((statement) => {
      if (!ts.isIfStatement(statement) || !exitsLoop(statement.thenStatement, owner)) return false;
      const condition = ts.skipOuterExpressions(statement.expression);
      return (
        ts.isBinaryExpression(condition) &&
        condition.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
        ts.isPropertyAccessExpression(condition.left) &&
        condition.left.name.text === 'length' &&
        sameBinding(condition.left.expression, rows, checker) &&
        fixedBatchSize(condition.right, checker) !== undefined
      );
    })
  );
}

function usesLastRow(
  expression: Expression,
  rows: Identifier,
  owner: Node,
  checker: CheckerAdapter,
  depth = 0,
): boolean {
  if (depth > 6) return false;
  const value = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(value)) {
    const initializer = localInitializer(value, owner, checker);
    return !!initializer && usesLastRow(initializer, rows, owner, checker, depth + 1);
  }
  if (ts.isElementAccessExpression(value) && sameBinding(value.expression, rows, checker)) {
    const index = value.argumentExpression;
    return (
      ts.isBinaryExpression(index) &&
      ts.isPropertyAccessExpression(index.left) &&
      index.left.name.text === 'length' &&
      sameBinding(index.left.expression, rows, checker) &&
      index.operatorToken.kind === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(index.right) &&
      Number(index.right.text) === 1
    );
  }
  return (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'at' &&
    sameBinding(value.expression.expression, rows, checker) &&
    value.arguments.length === 1 &&
    ts.isPrefixUnaryExpression(value.arguments[0]) &&
    value.arguments[0].operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(value.arguments[0].operand) &&
    Number(value.arguments[0].operand.text) === 1
  );
}

function hasKeysetBoundary(
  predicate: Expression | undefined,
  field: string,
  operator: string,
  cursor: Identifier,
  checker: CheckerAdapter,
): boolean {
  if (!predicate) return false;
  const value = ts.skipOuterExpressions(predicate);
  if (ts.isConditionalExpression(value) && sameBinding(value.condition, cursor, checker)) {
    return hasKeysetBoundary(value.whenTrue, field, operator, cursor, checker);
  }
  if (!ts.isObjectLiteralExpression(value)) return false;
  for (let index = value.properties.length - 1; index >= 0; index--) {
    const property = value.properties[index];
    if (ts.isSpreadAssignment(property))
      return hasKeysetBoundary(property.expression, field, operator, cursor, checker);
    if (!property.name || ts.isComputedPropertyName(property.name)) return false;
    if (property.name.text === field) {
      const bound = ts.isPropertyAssignment(property) && readProperty(property.initializer, operator);
      return !!bound && sameBinding(bound, cursor, checker);
    }
  }
  return false;
}

function mightSkipCursor(node: Node, update: Identifier, checker: CheckerAdapter): boolean {
  if (ts.isContinueStatement(node)) return true;
  if (
    ts.isIdentifier(node) &&
    node !== update &&
    node.text === update.text &&
    ts.isAssignmentTarget(node) &&
    sameBinding(node, update, checker)
  )
    return true;
  return !!ts.forEachChild(node, (child) => mightSkipCursor(child, update, checker) || undefined);
}

function advancesPageCursor(call: QueryCall, owner: RepeatOwner, options: Expression, checker: CheckerAdapter) {
  if (
    !isPageScan(owner) ||
    fixedBatchSize(readProperty(options, 'take'), checker) === undefined ||
    !ts.isBlock(owner.statement)
  )
    return false;
  const order = readProperty(options, 'orderBy');
  if (!order || !ts.isObjectLiteralExpression(order) || order.properties.length !== 1) return false;
  const sort = order.properties[0];
  if (
    !ts.isPropertyAssignment(sort) ||
    ts.isComputedPropertyName(sort.name) ||
    !sort.name.text ||
    !ts.isStringLiteralLike(sort.initializer)
  )
    return false;
  const sortField = sort.name.text;
  const direction = sort.initializer.text;
  if (direction !== 'asc' && direction !== 'desc') return false;
  if (!ts.isAwaitExpression(call.parent) || !ts.isVariableDeclaration(call.parent.parent)) return false;
  const declaration = call.parent.parent;
  const rows = declaration.name;
  if (!(declaration.parent.flags & ts.NodeFlags.Const) || !ts.isIdentifier(rows)) return false;
  return owner.statement.statements.some((statement) => {
    if (statement.pos < call.end || !ts.isExpressionStatement(statement)) return false;
    const assignment = statement.expression;
    if (
      !ts.isBinaryExpression(assignment) ||
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(assignment.left) ||
      !ts.isPropertyAccessExpression(assignment.right) ||
      assignment.right.name.text !== sortField ||
      !usesLastRow(assignment.right.expression, rows, owner, checker)
    )
      return false;
    const cursor = assignment.left;
    const binding = checker.getSymbolAtLocation(cursor)?.valueDeclaration;
    if (!binding || binding.getSourceFile() !== owner.getSourceFile() || binding.end > owner.pos) return false;
    const strict = hasKeysetBoundary(
      readProperty(options, 'where'),
      sortField,
      direction === 'asc' ? 'gt' : 'lt',
      cursor,
      checker,
    );
    const unique = readProperty(readProperty(options, 'cursor'), sortField);
    const skip = readProperty(options, 'skip');
    const skipsCursor =
      unique && sameBinding(unique, cursor, checker) && skip && ts.isNumericLiteral(skip) && Number(skip.text) === 1;
    return (strict || skipsCursor) && !mightSkipCursor(owner.statement, cursor, checker);
  });
}

export { advancesPageCursor, hasShortPageExit, isPageScan };
