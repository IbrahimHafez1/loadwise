'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { findRepeatOwner, outerExpression, promiseCombinatorOf } = require('./repeated.cjs');

const collectionGrowers = new Set(['push', 'add', 'set', 'unshift']);

function bindingNames(name, names = new Set()) {
  if (ts.isIdentifier(name)) names.add(name.text);
  // The native compiler does not report a hole such as `[first, , third]` as an omitted expression, so test for a name.
  else for (const element of name.elements) if (element.name) bindingNames(element.name, names);
  return names;
}

function mentions(node, names) {
  if (ts.isIdentifier(node)) return names.has(node.text);
  return !!ts.forEachChild(node, (child) => mentions(child, names) || undefined);
}

// `cursor = await repo.findOne({ where: { id: cursor.prevId } })` walks a chain only when the query reads the
// variable it assigns; an unrelated assignment does not make the call depend on its previous result.
function assignedCursor(assignment, expression, call) {
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  if (assignment.right !== expression || !ts.isIdentifier(assignment.left)) return;
  const names = new Set([assignment.left.text]);
  return mentions(call, names) ? names : undefined;
}

function resultNames(call) {
  let expression = outerExpression(call);
  if (ts.isAwaitExpression(expression.parent)) expression = outerExpression(expression.parent);
  const declaration = expression.parent;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer === expression)
    return bindingNames(declaration.name);
  return assignedCursor(declaration, expression, call) ?? new Set();
}

// The native compiler does not export ts.isIterationStatement.
function isLoop(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isBreakTarget(node) {
  return isLoop(node) || ts.isSwitchStatement(node);
}

// A statement that ends the loop: return/throw anywhere, or an unlabelled break that targets this loop.
function leavesLoop(node, nested = false) {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBreakStatement(node)) return !node.label && !nested;
  const insideInner = nested || isBreakTarget(node);
  return !!ts.forEachChild(node, (child) => leavesLoop(child, insideInner) || undefined);
}

function rootIdentifier(expression) {
  let value = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))
    value = ts.skipOuterExpressions(value.expression);
  return ts.isIdentifier(value) ? value : undefined;
}

function loopCondition(owner) {
  return ts.isForStatement(owner) ? owner.condition : owner.expression;
}

function conditionNamesOf(owner) {
  const names = new Set();
  const condition = loopCondition(owner);
  if (condition) {
    (function collect(node) {
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, collect);
    })(condition);
  }
  return names;
}

function isOpenEnded(owner) {
  const condition = loopCondition(owner);
  return !condition || ts.skipOuterExpressions(condition).kind === ts.SyntaxKind.TrueKeyword;
}

function usesLoopCounter(call, owner) {
  if (!ts.isForStatement(owner) || !owner.initializer || !ts.isVariableDeclarationList(owner.initializer)) return false;
  const counters = new Set();
  for (const declaration of owner.initializer.declarations) bindingNames(declaration.name, counters);
  // `const id = ids[index]` makes id a per-iteration value too.
  (function collectDerived(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer && mentions(node.initializer, counters))
      bindingNames(node.name, counters);
    ts.forEachChild(node, collectDerived);
  })(owner.statement);
  return mentions(call, counters);
}

const mutatingMethods = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'insert',
  'create',
  'createMany',
  'upsert',
]);
const mutatingSql = /^\s*(?:update|delete|insert|with)\b/i;

// prisma.x.deleteMany(...), db.delete(t).where(...), pool.query('DELETE ...').
function isMutation(call) {
  for (let node = ts.skipOuterExpressions(call); ts.isCallExpression(node);) {
    const callee = ts.skipOuterExpressions(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (mutatingMethods.has(callee.name.text)) return true;
    if (callee.name.text === 'query') {
      const [text] = node.arguments;
      return !!text && ts.isStringLiteralLike(text) && mutatingSql.test(text.text);
    }
    node = ts.skipOuterExpressions(callee.expression);
  }
  return false;
}

// Result-dependent loop: the call's own result decides whether another round runs (drain or page until empty,
// regenerate until unique), so each round needs the previous one and cannot be folded into one query.
function resultDrivesLoop(call, owner) {
  if (!ts.isWhileStatement(owner) && !ts.isDoStatement(owner) && !ts.isForStatement(owner)) return false;
  const tainted = resultNames(call);
  if (!tainted.size || usesLoopCounter(call, owner)) return false;
  const conditionNames = conditionNamesOf(owner);
  // A counted loop whose counter never reaches the query is a bounded pass limit, not an item iteration.
  const endsOnResult = isOpenEnded(owner) || ts.isForStatement(owner);
  let exitsOnResult = false;
  // A read that is re-run unchanged is a stationary re-read unless the loop acts on what it fetched.
  let consumesResult = false;

  function visit(node, underTaintedBranch) {
    if (ts.isFunctionLike(node)) return false;
    if (ts.isVariableDeclaration(node) && node.initializer && mentions(node.initializer, tainted)) {
      bindingNames(node.name, tainted);
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      mentions(node.expression, tainted)
    ) {
      bindingNames(node.initializer.declarations[0].name, tainted);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = ts.isIdentifier(node.left) ? node.left : undefined;
      if (target && conditionNames.has(target.text) && (underTaintedBranch || mentions(node.right, tainted)))
        return true;
    }
    if (ts.isCallExpression(node) && node.arguments.some((argument) => mentions(argument, tainted))) {
      consumesResult = true;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const root = rootIdentifier(node.expression.expression);
      if (
        root &&
        conditionNames.has(root.text) &&
        collectionGrowers.has(node.expression.name.text) &&
        node.arguments.some((argument) => mentions(argument, tainted))
      )
        return true;
    }
    if (ts.isIfStatement(node)) {
      const branchTainted = mentions(node.expression, tainted);
      if (
        branchTainted &&
        endsOnResult &&
        (leavesLoop(node.thenStatement) || (node.elseStatement && leavesLoop(node.elseStatement)))
      )
        exitsOnResult = true;
      return (
        visit(node.expression, underTaintedBranch) ||
        visit(node.thenStatement, underTaintedBranch || branchTainted) ||
        (!!node.elseStatement && visit(node.elseStatement, underTaintedBranch || branchTainted))
      );
    }
    return !!ts.forEachChild(node, (child) => visit(child, underTaintedBranch) || undefined);
  }
  return visit(owner.statement, false) || (exitsOnResult && (consumesResult || isMutation(call)));
}

function continuesLoop(node) {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isContinueStatement(node)) return !node.label;
  if (isLoop(node)) return false;
  return !!ts.forEachChild(node, (child) => continuesLoop(child) || undefined);
}

// try { await query } catch { continue }: an attempt loop retries after a failure (for example a unique
// violation). In a collection loop or a loop that consumes a queue, continue only moves on to the next item.
function retriesAfterFailure(call, owner) {
  const attemptLoop = ts.isForStatement(owner) && !usesLoopCounter(call, owner);
  if (!attemptLoop && !(ts.isWhileStatement(owner) && isOpenEnded(owner))) return false;
  for (let node = call; node !== owner && node.parent; node = node.parent) {
    const parent = node.parent;
    if (ts.isFunctionLike(parent)) return false;
    if (
      ts.isTryStatement(parent) &&
      parent.tryBlock === node &&
      parent.catchClause &&
      continuesLoop(parent.catchClause)
    )
      return true;
  }
  return false;
}

function isSequentialByDesign(call, owner) {
  return !!owner && !ts.isFunctionLike(owner) && (resultDrivesLoop(call, owner) || retriesAfterFailure(call, owner));
}

// A per-item try/catch that handles the failure without rethrowing, so the loop moves on to the next item.
function isolatesEachItem(call, owner) {
  for (let node = call; node && node !== owner; node = node.parent) {
    const statement = node.parent;
    if (!statement || !ts.isTryStatement(statement) || statement.tryBlock !== node || !statement.catchClause) continue;
    let rethrows = false;
    (function visit(child) {
      if (rethrows || ts.isFunctionLike(child)) return;
      if (ts.isThrowStatement(child)) rethrows = true;
      else ts.forEachChild(child, visit);
    })(statement.catchClause.block);
    if (!rethrows) return true;
  }
  return false;
}

// The collection a per-item loop walks: `for (x of list)`, `for (i = 0; i < list.length; ...)` or `list.map(...)`.
function walkedCollection(owner) {
  if (ts.isForOfStatement(owner)) return owner.expression;
  if (ts.isForStatement(owner)) {
    const condition = owner.condition && ts.skipOuterExpressions(owner.condition);
    if (
      condition &&
      ts.isBinaryExpression(condition) &&
      ts.isPropertyAccessExpression(condition.right) &&
      condition.right.name.text === 'length'
    )
      return condition.right.expression;
    return;
  }
  if (!ts.isFunctionLike(owner)) return;
  const call = outerExpression(owner).parent;
  if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) return call.expression.expression;
}

// `const rows = ...` in the code that owns the loop: the expression a collection identifier stands for.
function localValue(expression, checker) {
  const value = expression && ts.skipOuterExpressions(expression);
  if (!value || !ts.isIdentifier(value)) return value;
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.initializer
  )
    return ts.skipOuterExpressions(declaration.initializer);
  return value;
}

function awaitedCall(expression) {
  let value = expression && ts.skipOuterExpressions(expression);
  if (value && ts.isAwaitExpression(value)) value = ts.skipOuterExpressions(value.expression);
  return value && ts.isCallExpression(value) ? value : undefined;
}

// `[...ids].sort()` or `const ordered = list.toSorted(...)`: the loop visits items in a fixed order.
function sortedBeforeLoop(owner, checker) {
  const collection = localValue(walkedCollection(owner), checker);
  return (
    !!collection &&
    ts.isCallExpression(collection) &&
    ts.isPropertyAccessExpression(collection.expression) &&
    (collection.expression.name.text === 'sort' || collection.expression.name.text === 'toSorted')
  );
}

const transactionClientTypes = new Set(['EntityManager', 'QueryRunner', 'TransactionClient']);
const transactionMethods = new Set(['transaction', '$transaction']);

// An argument that is the transaction client: the parameter of a `transaction(async (manager) => ...)`
// callback, or a value typed as a transaction-scoped manager.
function passesTransactionClient(call, checker) {
  return call.arguments.some((argument) => {
    const value = ts.skipOuterExpressions(argument);
    if (!ts.isIdentifier(value)) return false;
    if (transactionClientTypes.has(checker.getTypeAtLocation(value).getSymbol()?.name)) return true;
    const parameter = checker.getSymbolAtLocation(value)?.valueDeclaration;
    const callback = parameter && ts.isParameter(parameter) ? parameter.parent : undefined;
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return false;
    const opener = outerExpression(callback).parent;
    return (
      ts.isCallExpression(opener) &&
      ts.isPropertyAccessExpression(opener.expression) &&
      transactionMethods.has(opener.expression.name.text)
    );
  });
}

function decoratorNames(node) {
  const names = [];
  for (const modifier of node.modifiers ?? []) {
    if (modifier.kind !== ts.SyntaxKind.Decorator) continue;
    let target = modifier.expression;
    if (ts.isCallExpression(target)) target = target.expression;
    if (ts.isIdentifier(target)) names.push(target.text);
    else if (ts.isPropertyAccessExpression(target)) names.push(target.name.text);
  }
  return names;
}

// NestJS `@Cron`, `@Interval` and `@Timeout` (and project wrappers named like them), Bull `@Process`,
// and the `process` method of a BullMQ `@Processor` worker.
const schedulerDecorator = /(?:Cron|Interval|Timeout)$|^Process$/;

function isScheduledMethod(method) {
  if (decoratorNames(method).some((name) => schedulerDecorator.test(name))) return true;
  return (
    ts.isIdentifier(method.name) &&
    method.name.text === 'process' &&
    ts.isClassLike(method.parent) &&
    decoratorNames(method.parent).includes('Processor')
  );
}

function callsMethod(caller, name) {
  return !!(function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.name.text === name
    )
      return true;
    return ts.forEachChild(node, visit);
  })(caller);
}

// The method is a scheduled or queue-worker entry, or a same-class helper one of those calls.
function runsOnSchedule(method) {
  if (isScheduledMethod(method)) return true;
  if (!method.name || !ts.isIdentifier(method.name) || !ts.isClassLike(method.parent)) return false;
  return method.parent.members.some(
    (member) =>
      member !== method &&
      ts.isMethodDeclaration(member) &&
      isScheduledMethod(member) &&
      callsMethod(member, method.name.text),
  );
}

const limitOptions = new Set(['take', 'limit', 'first']);
const limitClause = /\blimit\b/i;

function sqlText(argument) {
  const value = ts.skipOuterExpressions(argument);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isTemplateExpression(value))
    return value.head.text + value.templateSpans.map((span) => span.literal.text).join(' ');
}

// `find({ take: 100 })`, `findMany({ take })` or `query('... LIMIT $1')`: one capped page of rows.
function isCappedQuery(call) {
  return call.arguments.some((argument) => {
    const value = ts.skipOuterExpressions(argument);
    if (ts.isObjectLiteralExpression(value))
      return value.properties.some((property) => property.name && limitOptions.has(property.name.text));
    const text = sqlText(value);
    return text !== undefined && limitClause.test(text);
  });
}

function scheduledBatch(owner, checker) {
  if (findRepeatOwner(owner, checker)) return false;
  const method = ts.findAncestor(owner, ts.isMethodDeclaration);
  const source = awaitedCall(localValue(walkedCollection(owner), checker));
  return !!method && !!source && isCappedQuery(source) && runsOnSchedule(method);
}

const singleRecordReads = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findOne',
  'findOneOrFail',
  'findOneBy',
  'findOneByOrFail',
]);
const relationOptions = new Set(['include', 'select', 'relations']);

function loadsRelation(options, name) {
  const value = ts.skipOuterExpressions(options);
  if (ts.isArrayLiteralExpression(value))
    return value.elements.some((element) => ts.isStringLiteralLike(element) && element.text === name);
  return (
    ts.isObjectLiteralExpression(value) &&
    value.properties.some((property) => property.name && property.name.text === name)
  );
}

// `for (const item of order.items)` where `order` is one record read by key with its `items` relation.
function childrenOfOneRecord(owner, checker) {
  const collection = walkedCollection(owner);
  const children = collection && ts.skipOuterExpressions(collection);
  if (!children || !ts.isPropertyAccessExpression(children) || !ts.isIdentifier(children.expression)) return;
  const read = awaitedCall(localValue(children.expression, checker));
  if (!read || !ts.isPropertyAccessExpression(read.expression) || !singleRecordReads.has(read.expression.name.text))
    return;
  const options = read.arguments[0] && ts.skipOuterExpressions(read.arguments[0]);
  if (!options || !ts.isObjectLiteralExpression(options)) return;
  const relation = children.name.text;
  const loaded = options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      relationOptions.has(property.name.text) &&
      loadsRelation(property.initializer, relation),
  );
  return loaded ? children.getText() : undefined;
}

function loopNames(owner) {
  const indexes = new Set();
  const items = new Set();
  if (ts.isForStatement(owner) && owner.initializer && ts.isVariableDeclarationList(owner.initializer)) {
    for (const declaration of owner.initializer.declarations) bindingNames(declaration.name, indexes);
  }
  if (ts.isForOfStatement(owner) && ts.isVariableDeclarationList(owner.initializer)) {
    const binding = owner.initializer.declarations[0]?.name;
    const walked = ts.skipOuterExpressions(owner.expression);
    const entries =
      ts.isCallExpression(walked) &&
      ts.isPropertyAccessExpression(walked.expression) &&
      walked.expression.name.text === 'entries';
    if (binding && entries && ts.isArrayBindingPattern(binding)) {
      const [index, item] = binding.elements;
      if (index && !ts.isOmittedExpression(index)) bindingNames(index.name, indexes);
      if (item && !ts.isOmittedExpression(item)) bindingNames(item.name, items);
    } else if (binding) bindingNames(binding, items);
  }
  return { indexes, items };
}

function readsOwnField(node, items, field) {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    items.has(node.expression.text) &&
    node.name.text === field
  )
    return true;
  return !!ts.forEachChild(node, (child) => readsOwnField(child, items, field) || undefined);
}

// `update(row.id, { position: index + 1 })` or `{ position: row.position + 1 }`: each row moves to a slot
// derived from its place in the loop or its current slot, so the order of the writes matters.
function rewritesPositions(call, owner) {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'update') return false;
  const values = call.arguments.at(-1) && ts.skipOuterExpressions(call.arguments.at(-1));
  if (!values || !ts.isObjectLiteralExpression(values)) return false;
  const { indexes, items } = loopNames(owner);
  return values.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name &&
      !ts.isComputedPropertyName(property.name) &&
      (mentions(property.initializer, indexes) || readsOwnField(property.initializer, items, property.name.text)),
  );
}

// `if (leaseLost.aborted) break;` in the loop body: a job that holds a lease and stops between items once it loses it.
function stopsOnLostLease(owner, checker) {
  if (ts.isFunctionLike(owner) || !ts.isBlock(owner.statement)) return false;
  return owner.statement.statements.some((statement) => {
    if (!ts.isIfStatement(statement) || !leavesLoop(statement.thenStatement)) return false;
    const condition = ts.skipOuterExpressions(statement.expression);
    return (
      ts.isPropertyAccessExpression(condition) &&
      condition.name.text === 'aborted' &&
      checker.getTypeAtLocation(condition.expression).getSymbol()?.name === 'AbortSignal'
    );
  });
}

const reviewAdvice = 'Review if the list can grow large.';

// Loops that process items one at a time on purpose. The finding stays visible, with the reason it may be intended.
function loopReviewReason(call, owner, checker, ruleId) {
  if (!owner) return;
  if (ruleId === 'orm-query-in-loop' && rewritesPositions(call, owner))
    return 'Each row is written to a position derived from its place in the loop or its current position (a renumber or shift). Under a unique index the order of these writes matters, so a set-based rewrite must keep the same phases, for example one `UPDATE ... FROM (VALUES ...)` per phase.';
  if (isolatesEachItem(call, owner))
    return `Each item runs in its own try/catch that handles the failure and moves on, so one bad item does not stop the rest. A batched version must keep that per-item error isolation, for example by validating in bulk first or using a savepoint per item. ${reviewAdvice}`;
  if (promiseCombinatorOf(owner) === 'allSettled')
    return `\`Promise.allSettled\` runs the items at once and keeps each failure separate, so one bad item does not stop the rest. A batched version must keep that per-item error isolation. ${reviewAdvice}`;
  if (scheduledBatch(owner, checker))
    return 'Runs in a scheduled job or queue worker over one capped page of rows (the source query has a take or limit), so the per-item cost is bounded per run. Review if the page size or the schedule frequency grows.';
  const children = childrenOfOneRecord(owner, checker);
  if (children)
    return `The loop walks \`${children}\`, the child rows of one record loaded by key, which usually hold a handful of entries. Review if one record can carry many children.`;
}

module.exports = {
  isBreakTarget,
  isSequentialByDesign,
  isolatesEachItem,
  loopReviewReason,
  passesTransactionClient,
  stopsOnLostLease,
  sortedBeforeLoop,
};
