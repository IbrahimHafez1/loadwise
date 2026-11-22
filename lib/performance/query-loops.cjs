'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { elementBinding, findRepeatOwner, isStandardArrayCall, outerExpression } = require('./repeated.cjs');
const { isBreakTarget } = require('./sequential-loops.cjs');

// Retry and probe loops rarely run more than a handful of times; larger constants are treated as real scans.
const MAX_BOUNDED_ATTEMPTS = 10;
const MAX_LITERAL_ITERATIONS = 5;
// An enum or literal union up to this size is a closed set of values, such as notification channels.
const MAX_LITERAL_DOMAIN = 10;
const literalFlags =
  ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.EnumLiteral;
const growingMethods = new Set(['push', 'unshift', 'splice', 'fill', 'copyWithin']);

// A break leaves the scanned loop unless its target, the labelled statement or the nearest loop or switch,
// sits inside that loop, as in a one-item inner `for (const key of [id])`.
function breaksOutOf(statement, owner) {
  const label = statement.label?.text;
  for (let node = statement.parent; node && node !== owner; node = node.parent) {
    const isTarget = label ? ts.isLabeledStatement(node) && node.label.text === label : isBreakTarget(node);
    if (isTarget) return false;
  }
  return true;
}

function exitsLoop(statement, owner) {
  if (ts.isBlock(statement)) return statement.statements.length === 1 && exitsLoop(statement.statements[0], owner);
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    (ts.isBreakStatement(statement) && breaksOutOf(statement, owner))
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
      if (!ts.isVariableStatement(current) && !ts.isExpressionStatement(current)) continue;
      const next = parent.statements[parent.statements.indexOf(current) + 1];
      if (next && exitsLoop(next, owner)) exits = true;
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

const objectReaders = new Set(['keys', 'values', 'entries']);

// `Object.values(Status)` over an enum, or `Object.keys(LIMITS)` over a `const` object literal: a key set
// fixed in the source, no larger than a literal domain.
function readsFixedKeys(call, checker) {
  const receiver = ts.skipOuterExpressions(call.expression.expression);
  if (
    !ts.isIdentifier(receiver) ||
    receiver.text !== 'Object' ||
    !objectReaders.has(call.expression.name.text) ||
    call.arguments.length !== 1
  )
    return false;
  const target = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isIdentifier(target)) return false;
  let symbol = checker.getSymbolAtLocation(target);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (!declaration) return false;
  if (ts.isEnumDeclaration(declaration)) return declaration.members.length <= MAX_LITERAL_DOMAIN;
  if (!ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
  const table = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
  return (
    !!table &&
    ts.isObjectLiteralExpression(table) &&
    table.properties.length <= MAX_LITERAL_DOMAIN &&
    !table.properties.some(ts.isSpreadAssignment)
  );
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
    if (readsFixedKeys(value, checker)) return true;
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

// Items typed as a small literal union, such as the members of an enum, can take only a few distinct values.
function hasSmallLiteralDomain(owner, checker) {
  const binding = elementBinding(owner);
  if (!binding || !ts.isIdentifier(binding)) return false;
  const type = checker.getTypeAtLocation(binding);
  const members = type.isUnion() ? type.types : [type];
  return members.length <= MAX_LITERAL_DOMAIN && members.every((member) => member.flags & literalFlags);
}

function isConstantValue(expression, checker) {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return true;
  return ts.isPropertyAccessExpression(value) && !!(checker.getTypeAtLocation(value).flags & literalFlags);
}

// `if (channel === Channel.Push) await query()` runs for one value of the loop item, not for every item.
function matchesOneItemValue(call, owner, checker) {
  const binding = elementBinding(owner);
  if (!binding || !ts.isIdentifier(binding)) return false;
  const comparesItem = (condition) => {
    const value = ts.skipOuterExpressions(condition);
    if (!ts.isBinaryExpression(value)) return false;
    if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return comparesItem(value.left) || comparesItem(value.right);
    if (
      value.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      value.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
    )
      return false;
    return [
      [value.left, value.right],
      [value.right, value.left],
    ].some(([item, constant]) => sameBinding(item, binding, checker) && isConstantValue(constant, checker));
  };
  for (let current = call; current !== owner && current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isIfStatement(parent) && parent.thenStatement === current && comparesItem(parent.expression)) return true;
  }
  return false;
}

// Retry loops and fixed-size literal lists issue a bounded number of queries that batching cannot improve.
function isBoundedLoop(owner, checker) {
  if (findRepeatOwner(owner, checker)) return false;
  return (
    hasSmallConstantBound(owner, checker) ||
    isSmallLiteralCollection(iteratedCollection(owner), checker) ||
    hasSmallLiteralDomain(owner, checker)
  );
}

// `for (let attempt = 0; ; attempt++) { try { return await save(row); } catch { ... } }` repeats the call only
// after a failure. A collection loop that leaves on success still runs it once per item.
function retriesUntilSuccess(call, owner, checker) {
  if (!ts.isForStatement(owner) && !ts.isWhileStatement(owner) && !ts.isDoStatement(owner)) return false;
  if (ts.isForStatement(owner) && iteratedByCounter(owner)) return false;
  let exits = false;
  let retried = false;
  for (let current = call; current !== owner; current = current.parent) {
    const parent = current.parent;
    if (ts.isFunctionLike(parent) || ts.isSwitchStatement(parent)) return false;
    if (ts.isReturnStatement(current)) exits = true;
    if (ts.isTryStatement(parent) && parent.tryBlock === current && parent.catchClause) retried = true;
    if (!exits && ts.isBlock(parent) && (ts.isVariableStatement(current) || ts.isExpressionStatement(current))) {
      const next = parent.statements[parent.statements.indexOf(current) + 1];
      if (next && exitsLoop(next, owner)) exits = true;
    }
  }
  // A retry inside an item loop still runs once per outer item.
  return exits && retried && !findRepeatOwner(owner, checker);
}

// `for (let index = 0; index < rows.length; index++)` walks a collection rather than counting attempts.
function iteratedByCounter(loop) {
  const condition = loop.condition && ts.skipOuterExpressions(loop.condition);
  return (
    !!condition &&
    ts.isBinaryExpression(condition) &&
    ts.isPropertyAccessExpression(condition.right) &&
    condition.right.name.text === 'length'
  );
}

// `const taken = await find(candidate); if (!taken) return candidate;` in a counter loop probes until the
// first free value, so it normally runs once. A collection loop that exits on a miss still runs per item.
function probesUntilFree(call, owner, checker) {
  if (!ts.isForStatement(owner) && !ts.isWhileStatement(owner) && !ts.isDoStatement(owner)) return false;
  let expression = outerExpression(call);
  if (ts.isAwaitExpression(expression.parent)) expression = outerExpression(expression.parent);
  const declaration = expression.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isVariableStatement(statement) || !ts.isBlock(block) || block.parent !== owner) return false;
  const next = block.statements[block.statements.indexOf(statement) + 1];
  if (!next || !ts.isIfStatement(next) || next.elseStatement) return false;
  const condition = ts.skipOuterExpressions(next.expression);
  const exit = ts.isBlock(next.thenStatement) ? next.thenStatement.statements[0] : next.thenStatement;
  return (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken &&
    sameBinding(ts.skipOuterExpressions(condition.operand), declaration.name, checker) &&
    !!exit &&
    ts.isReturnStatement(exit)
  );
}

function sameText(left, right) {
  return left.getText().replace(/\s+/g, '') === right.getText().replace(/\s+/g, '');
}

function isNullish(node) {
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}

// The caches a `!hit` or `!cache.has(key)` miss test reads, or with `hit` set the caches a `hit`,
// `cache.has(key)` or `hit !== undefined` hit test reads: `hit` comes from `cache.get(key)`, `cache[key]`,
// or a lookup call that receives the cache, such as `findByName(cached, name)` or `cached.find(...)`.
function testedCaches(condition, checker, hit = false) {
  const equality = hit
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
  return [...receiver, ...initializer.arguments.filter((argument) => ts.isIdentifier(argument))];
}

// The miss branch writes the loaded value back with `cache.set`, `cache.push` or `cache[key] =`.
function storesInto(statement, cache) {
  return !!(function visit(node) {
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

// `cache ??= await load()` and a lookup that loads only on a miss and stores the result run once per distinct key.
function isMemoised(call, checker, owner) {
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
    let current = call;
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

function onlyCalledOnFailure(method) {
  const name = method.name && (ts.isIdentifier(method.name) || ts.isPrivateIdentifier(method.name)) && method.name.text;
  if (!name) return false;
  const isPrivate =
    ts.isPrivateIdentifier(method.name) || !!(ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Private);
  const scope = ts.isMethodDeclaration(method)
    ? isPrivate && method.parent
    : ts.isFunctionDeclaration(method) &&
      !(ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Export) &&
      method.getSourceFile();
  if (!scope) return false;
  let calls = 0;
  let failureOnly = true;
  (function visit(node) {
    if (!failureOnly) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const matches = ts.isMethodDeclaration(method)
        ? ts.isPropertyAccessExpression(callee) &&
          callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
          callee.name.text === name
        : ts.isIdentifier(callee) && callee.text === name;
      if (matches) {
        calls++;
        if (!insideFailureHandler(node, method)) failureOnly = false;
      }
    }
    ts.forEachChild(node, visit);
  })(scope);
  return calls > 0 && failureOnly;
}

function isFailureCallback(node) {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const call = outerExpression(node).parent;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'catch' &&
    call.arguments[0] === outerExpression(node)
  );
}

// A catch block, a `.catch()` handler, or code reached only through them, up to `boundary`.
function insideFailureHandler(node, boundary) {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (ts.isCatchClause(current) || isFailureCallback(current)) return true;
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) return false;
  }
  return false;
}

// Rollback and cleanup work that runs only after a failure, not once per item of a normal run.
function onFailurePath(call) {
  if (insideFailureHandler(call)) return true;
  const method = ts.findAncestor(
    call,
    (node) => ts.isFunctionLike(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node),
  );
  return (
    !!method && (ts.isMethodDeclaration(method) || ts.isFunctionDeclaration(method)) && onlyCalledOnFailure(method)
  );
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
        // `OR: page.map((row) => filterFor(row.id, row.since))` builds one arm per row through a helper.
        if (ts.isCallExpression(filter) && projectsItem(callback, checker)) return true;
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
  if (
    !owner ||
    runsAtMostOnce(call, owner, checker) ||
    probesUntilFree(call, owner, checker) ||
    retriesUntilSuccess(call, owner, checker)
  )
    return false;
  if (isBoundedLoop(owner, checker) || matchesOneItemValue(call, owner, checker)) return false;
  if (isMemoised(call, checker, owner) || onFailurePath(call)) return false;
  if (insertRows && isBatchCollection(insertRows, owner, checker)) return false;
  // Tagged templates such as a raw Prisma statement have no argument list.
  const options = call.arguments?.[0];
  const bulkRead =
    (family === 'Prisma' && (method === 'groupBy' || method === 'findMany')) ||
    (family === 'TypeORM' && (method === 'find' || method === 'findBy'));
  if (!bulkRead || !options) return true;
  const filter = method === 'findBy' ? options : readProperty(options, 'where');
  return !batchPredicate(filter, owner, checker, family) && !advancesPageCursor(call, owner, options, checker);
}

module.exports = { isBatchCollection, isGrownLater, isMemoised, shouldReportLoopQuery };
