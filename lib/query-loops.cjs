'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { findRepeatOwner, isStandardArrayCall, outerExpression } = require('./repeated.cjs');

// Retry and probe loops rarely run more than a handful of times; larger constants are treated as real scans.
const MAX_BOUNDED_ATTEMPTS = 10;
const MAX_LITERAL_ITERATIONS = 5;
const growingMethods = new Set(['push', 'unshift', 'splice', 'fill', 'copyWithin']);

function exitsLoop(statement) {
  if (ts.isBlock(statement)) return statement.statements.length === 1 && exitsLoop(statement.statements[0]);
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    (ts.isBreakStatement(statement) && !statement.label)
  );
}

function runsAtMostOnce(call, owner, checker) {
  if (ts.isFunctionLike(owner)) return false;
  let exits = false;
  let checkedStatement = false;
  for (let current = call; current !== owner; current = current.parent) {
    const parent = current.parent;
    // A catch may retry the failed query; a finally can replace a return with continue.
    if (ts.isTryStatement(parent) || ts.isFunctionLike(parent) || ts.isSwitchStatement(parent)) return false;
    if (ts.isReturnStatement(current) || ts.isThrowStatement(current)) exits = true;
    if (!checkedStatement && ts.isBlock(parent)) {
      checkedStatement = true;
      if (ts.isVariableStatement(current) || ts.isExpressionStatement(current)) {
        const next = parent.statements[parent.statements.indexOf(current) + 1];
        if (next && exitsLoop(next)) exits = true;
      }
    }
  }
  // An inner break still runs once per outer item. Keep the advisory in ambiguous nested loops.
  return exits && !findRepeatOwner(owner, checker);
}

function constantNumber(expression, checker) {
  if (!expression) return;
  let value = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(value)) {
    const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
      return;
    value = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
  }
  if (value && ts.isNumericLiteral(value)) return Number(value.text);
}

function isIncremented(counter, loop, checker) {
  return !!(function visit(node) {
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      node.operator === ts.SyntaxKind.PlusPlusToken &&
      sameBinding(node.operand, counter, checker)
    )
      return true;
    if (ts.isBinaryExpression(node) && sameBinding(node.left, counter, checker)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) return true;
      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isBinaryExpression(node.right) &&
        node.right.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
        return true;
    }
    return ts.forEachChild(node, visit);
  })(loop);
}

// `while (attempts < maxAttempts)` with an incremented counter and a small constant bound: a retry or probe loop.
function boundsCounter(condition, loop, checker) {
  const value = ts.skipOuterExpressions(condition);
  if (!ts.isBinaryExpression(value)) return false;
  // Any conjunct that caps the counter caps the loop.
  if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return boundsCounter(value.left, loop, checker) || boundsCounter(value.right, loop, checker);
  const inclusive = value.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken;
  if (!ts.isIdentifier(value.left) || (!inclusive && value.operatorToken.kind !== ts.SyntaxKind.LessThanToken))
    return false;
  const limit = constantNumber(value.right, checker);
  return (
    limit !== undefined &&
    limit + (inclusive ? 1 : 0) <= MAX_BOUNDED_ATTEMPTS &&
    isIncremented(value.left, loop, checker)
  );
}

function hasSmallConstantBound(loop, checker) {
  if (!ts.isWhileStatement(loop) && !ts.isDoStatement(loop) && !ts.isForStatement(loop)) return false;
  const test = ts.isForStatement(loop) ? loop.condition : loop.expression;
  return !!test && boundsCounter(test, loop, checker);
}

// A flatMap callback that returns a scalar or [] never yields more than one item per input.
function yieldsAtMostOne(result, checker) {
  const value = ts.skipOuterExpressions(result);
  if (ts.isConditionalExpression(value))
    return yieldsAtMostOne(value.whenTrue, checker) && yieldsAtMostOne(value.whenFalse, checker);
  if (ts.isArrayLiteralExpression(value)) return value.elements.length <= 1 && !value.elements.some(ts.isSpreadElement);
  const type = checker.getTypeAtLocation(value);
  return !(type.isUnion() ? type.types : [type]).some(
    (member) => member.getSymbol()?.name === 'Array' || member.getSymbol()?.name === 'ReadonlyArray',
  );
}

function flatMapKeepsSize(call, checker) {
  const callback = call.arguments[0];
  if (!callback || !ts.isArrowFunction(callback)) return false;
  const body = ts.skipOuterExpressions(callback.body);
  return !ts.isBlock(body) && yieldsAtMostOne(body, checker);
}

function iteratedCollection(owner) {
  if (ts.isForOfStatement(owner)) return owner.expression;
  if (!ts.isFunctionLike(owner)) return;
  const call = outerExpression(owner).parent;
  return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
    ? call.expression.expression
    : undefined;
}

// A `const` array can still grow, and an empty literal is almost always an accumulator filled later.
function isGrownLater(declaration, checker) {
  const scope = ts.findAncestor(declaration, (node) => ts.isBlock(node) || ts.isSourceFile(node)) ?? declaration;
  return !!(function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      growingMethods.has(node.expression.name.text) &&
      sameBinding(node.expression.expression, declaration.name, checker)
    )
      return true;
    if (
      ts.isBinaryExpression(node) &&
      ts.isElementAccessExpression(node.left) &&
      ts.isAssignmentOperator(node.operatorToken.kind) &&
      sameBinding(node.left.expression, declaration.name, checker)
    )
      return true;
    return ts.forEachChild(node, visit);
  })(scope);
}

function isSmallLiteralCollection(expression, checker, depth = 0) {
  if (!expression || depth > 6) return false;
  const value = ts.skipOuterExpressions(expression);
  if (ts.isArrayLiteralExpression(value))
    return (
      value.elements.length > 0 &&
      value.elements.length <= MAX_LITERAL_ITERATIONS &&
      !value.elements.some(ts.isSpreadElement)
    );
  if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
    // These array methods never return more items than the receiver holds.
    const method = value.expression.name.text;
    return (
      (['filter', 'slice', 'map'].includes(method) || (method === 'flatMap' && flatMapKeepsSize(value, checker))) &&
      isStandardArrayCall(value, checker) &&
      isSmallLiteralCollection(value.expression.expression, checker, depth + 1)
    );
  }
  if (!ts.isIdentifier(value)) return false;
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const) &&
    isSmallLiteralCollection(declaration.initializer, checker, depth + 1) &&
    !isGrownLater(declaration, checker)
  );
}

// Retry loops and fixed-size literal lists issue a bounded number of queries that batching cannot improve.
function isBoundedLoop(owner, checker) {
  if (findRepeatOwner(owner, checker)) return false;
  return hasSmallConstantBound(owner, checker) || isSmallLiteralCollection(iteratedCollection(owner), checker);
}

function readProperty(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index];
    if (!property.name || ts.isComputedPropertyName(property.name)) return;
    if (property.name.text === name) return ts.isPropertyAssignment(property) ? property.initializer : undefined;
  }
}

function sameBinding(left, right, checker) {
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text !== right.text) return false;
  const declaration = checker.getSymbolAtLocation(left)?.valueDeclaration;
  return declaration && declaration === checker.getSymbolAtLocation(right)?.valueDeclaration;
}

function isPageScan(loop) {
  return (
    (ts.isWhileStatement(loop) && loop.expression.kind === ts.SyntaxKind.TrueKeyword) ||
    (ts.isForStatement(loop) && !loop.initializer && !loop.condition && !loop.incrementor)
  );
}

function localInitializer(identifier, owner, checker) {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.getSourceFile() === owner.getSourceFile() &&
    declaration.pos >= owner.pos &&
    declaration.end <= owner.end
  ) {
    return declaration.initializer;
  }
}

function fixedBatchSize(expression, checker) {
  if (!expression) return;
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
      return;
    expression = declaration.initializer;
  }
  if (expression && ts.isNumericLiteral(expression) && Number(expression.text) > 1) return Number(expression.text);
}

function projectsSingletons(expression, checker, depth = 0) {
  if (depth > 6) return false;
  const value = ts.skipOuterExpressions(expression);
  const singleton = (item) =>
    ts.isArrayLiteralExpression(item) && item.elements.length <= 1 && !item.elements.some(ts.isSpreadElement);
  if (ts.isArrayLiteralExpression(value)) return value.elements.every(singleton);
  if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
    const callback = value.arguments[0];
    if (value.expression.name.text === 'map' && callback && ts.isArrowFunction(callback)) {
      const result = ts.skipOuterExpressions(callback.body);
      return (
        singleton(result) ||
        (ts.isBlock(result) &&
          result.statements.length === 1 &&
          ts.isReturnStatement(result.statements[0]) &&
          result.statements[0].expression &&
          singleton(result.statements[0].expression))
      );
    }
    return (
      ['filter', 'slice'].includes(value.expression.name.text) &&
      projectsSingletons(value.expression.expression, checker, depth + 1)
    );
  }
  if (!ts.isIdentifier(value)) return false;
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
  return (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.initializer &&
    projectsSingletons(declaration.initializer, checker, depth + 1)
  );
}

// A short final page ends this scan. The rows used for a set query must be the same collection.
function hasShortPageExit(rows, owner, checker) {
  return (
    ts.isBlock(owner.statement) &&
    owner.statement.statements.some((statement) => {
      if (!ts.isIfStatement(statement) || !exitsLoop(statement.thenStatement)) return false;
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

function projectsItem(callback, checker) {
  if (!callback || !ts.isArrowFunction(callback) || !callback.parameters.length) return false;
  const parameter = callback.parameters[0];
  const body = ts.skipOuterExpressions(callback.body);
  if (ts.isBlock(body)) return false;
  function usesParameter(node) {
    if (ts.isIdentifier(node)) {
      const symbol =
        ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
      const binding = symbol?.valueDeclaration;
      return (
        binding &&
        binding.getSourceFile() === parameter.getSourceFile() &&
        binding.pos >= parameter.pos &&
        binding.end <= parameter.end
      );
    }
    return ts.forEachChild(node, (child) => usesParameter(child) || undefined);
  }
  return usesParameter(body);
}

function isBatchCollection(expression, owner, checker, depth = 0) {
  if (!expression || depth > 8) return false;
  const value = ts.skipOuterExpressions(expression);
  const follows = (child) => isBatchCollection(child, owner, checker, depth + 1);
  if (ts.isIdentifier(value)) {
    if (
      ts.isForOfStatement(owner) &&
      ts.isVariableDeclarationList(owner.initializer) &&
      sameBinding(value, owner.initializer.declarations[0].name, checker)
    ) {
      const type = checker.getTypeAtLocation(value).getSymbol();
      return (
        (type?.name === 'Array' || type?.name === 'ReadonlyArray') &&
        type.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile())) &&
        !projectsSingletons(owner.expression, checker)
      );
    }
    const initializer = localInitializer(value, owner, checker);
    if (!initializer) return false;
    if (isPageScan(owner) && ts.isAwaitExpression(initializer) && hasShortPageExit(value, owner, checker)) return true;
    return follows(initializer);
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    ['map', 'flatMap', 'filter'].includes(value.expression.name.text) &&
    isStandardArrayCall(value, checker)
  ) {
    return (
      (value.expression.name.text === 'filter' || projectsItem(value.arguments[0], checker)) &&
      follows(value.expression.expression)
    );
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'slice' &&
    ts.isForStatement(owner) &&
    owner.incrementor &&
    ts.isBinaryExpression(owner.incrementor) &&
    owner.incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    value.arguments.length === 2
  ) {
    const [start, end] = value.arguments;
    const stride = fixedBatchSize(owner.incrementor.right, checker);
    return (
      stride !== undefined &&
      sameBinding(start, owner.incrementor.left, checker) &&
      ts.isBinaryExpression(end) &&
      end.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      sameBinding(start, end.left, checker) &&
      fixedBatchSize(end.right, checker) === stride &&
      isStandardArrayCall(value, checker)
    );
  }
  if (ts.isArrayLiteralExpression(value) && value.elements.length === 1 && ts.isSpreadElement(value.elements[0])) {
    return follows(value.elements[0].expression);
  }
  if (
    ts.isNewExpression(value) &&
    value.arguments?.length === 1 &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'Set'
  ) {
    const origin = checker.getSymbolAtLocation(value.expression)?.valueDeclaration;
    return origin && isDefaultLibrary(checker, origin.getSourceFile()) && follows(value.arguments[0]);
  }
  return false;
}

function batchPredicate(predicate, owner, checker, family) {
  if (!predicate) return false;
  // TypeORM WHERE arrays are disjunctions. One unrestricted arm broadens the entire match.
  if (ts.isArrayLiteralExpression(predicate))
    return (
      predicate.elements.length > 0 && predicate.elements.every((item) => batchPredicate(item, owner, checker, family))
    );
  if (!ts.isObjectLiteralExpression(predicate)) return false;
  const seen = new Set();
  for (let index = predicate.properties.length - 1; index >= 0; index--) {
    const property = predicate.properties[index];
    if (!property.name || ts.isComputedPropertyName(property.name)) return false;
    const name = property.name.text;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!ts.isPropertyAssignment(property)) continue;
    const value = property.initializer;
    if (
      family === 'Prisma' &&
      name !== 'NOT' &&
      name !== 'AND' &&
      name !== 'OR' &&
      isBatchCollection(readProperty(value, 'in'), owner, checker)
    )
      return true;
    if (
      family === 'Prisma' &&
      name === 'OR' &&
      ts.isArrayLiteralExpression(value) &&
      batchPredicate(value, owner, checker, family)
    )
      return true;
    if (
      family === 'Prisma' &&
      name === 'OR' &&
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      value.expression.name.text === 'map' &&
      isBatchCollection(value, owner, checker)
    ) {
      const callback = value.arguments[0];
      if (
        callback &&
        ts.isArrowFunction(callback) &&
        callback.parameters.length &&
        ts.isIdentifier(callback.parameters[0].name)
      ) {
        const filter = ts.skipOuterExpressions(callback.body);
        if (
          ts.isObjectLiteralExpression(filter) &&
          filter.properties.some(
            (field) =>
              ts.isPropertyAssignment(field) &&
              readProperty(filter, field.name.text) === field.initializer &&
              ts.isPropertyAccessExpression(field.initializer) &&
              sameBinding(field.initializer.expression, callback.parameters[0].name, checker),
          )
        )
          return true;
      }
    }
    if (
      family === 'TypeORM' &&
      ts.isCallExpression(value) &&
      value.arguments.length === 1 &&
      isBatchCollection(value.arguments[0], owner, checker)
    ) {
      const declaration = checker.getResolvedSignature(value)?.declaration;
      if (
        declaration?.name?.text === 'In' &&
        /\/node_modules\/typeorm\//.test(declaration.getSourceFile().fileName.replaceAll('\\', '/'))
      )
        return true;
    }
  }
  return false;
}

function usesLastRow(expression, rows, owner, checker, depth = 0) {
  if (depth > 6) return false;
  const value = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(value)) {
    const initializer = localInitializer(value, owner, checker);
    return initializer && usesLastRow(initializer, rows, owner, checker, depth + 1);
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

function hasKeysetBoundary(predicate, field, operator, cursor, checker) {
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
      return bound && sameBinding(bound, cursor, checker);
    }
  }
  return false;
}

function mightSkipCursor(node, update, checker) {
  if (ts.isContinueStatement(node)) return true;
  if (
    ts.isIdentifier(node) &&
    node !== update &&
    node.text === update.text &&
    ts.isAssignmentTarget(node) &&
    sameBinding(node, update, checker)
  )
    return true;
  return ts.forEachChild(node, (child) => mightSkipCursor(child, update, checker) || undefined);
}

function advancesPageCursor(call, owner, options, checker) {
  if (
    !isPageScan(owner) ||
    fixedBatchSize(readProperty(options, 'take'), checker) === undefined ||
    !ts.isBlock(owner.statement)
  )
    return false;
  const order = readProperty(options, 'orderBy');
  if (!order || !ts.isObjectLiteralExpression(order) || order.properties.length !== 1) return false;
  const sort = order.properties[0];
  if (!ts.isPropertyAssignment(sort) || !sort.name.text || !ts.isStringLiteralLike(sort.initializer)) return false;
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
      assignment.right.name.text !== sort.name.text ||
      !usesLastRow(assignment.right.expression, rows, owner, checker)
    )
      return false;
    const cursor = assignment.left;
    const binding = checker.getSymbolAtLocation(cursor)?.valueDeclaration;
    if (!binding || binding.getSourceFile() !== owner.getSourceFile() || binding.end > owner.pos) return false;
    const strict = hasKeysetBoundary(
      readProperty(options, 'where'),
      sort.name.text,
      direction === 'asc' ? 'gt' : 'lt',
      cursor,
      checker,
    );
    const unique = readProperty(readProperty(options, 'cursor'), sort.name.text);
    const skip = readProperty(options, 'skip');
    const skipsCursor =
      unique && sameBinding(unique, cursor, checker) && skip && ts.isNumericLiteral(skip) && Number(skip.text) === 1;
    return (strict || skipsCursor) && !mightSkipCursor(owner.statement, cursor, checker);
  });
}

function shouldReportLoopQuery(
  call,
  checker,
  { family, method, owner = findRepeatOwner(call, checker), insertRows } = {},
) {
  if (!owner || runsAtMostOnce(call, owner, checker)) return false;
  if (isBoundedLoop(owner, checker)) return false;
  if (insertRows && isBatchCollection(insertRows, owner, checker)) return false;
  const options = call.arguments[0];
  const bulkRead =
    (family === 'Prisma' && (method === 'groupBy' || method === 'findMany')) ||
    (family === 'TypeORM' && (method === 'find' || method === 'findBy'));
  if (!bulkRead || !options) return true;
  const filter = method === 'findBy' ? options : readProperty(options, 'where');
  return !batchPredicate(filter, owner, checker, family) && !advancesPageCursor(call, owner, options, checker);
}

module.exports = { isBatchCollection, shouldReportLoopQuery };
