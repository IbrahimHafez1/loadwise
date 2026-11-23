'use strict';

const { calleeName, skipParentheses } = require('./call-syntax.cjs');
const { syntax: ts } = require('./compiler.cjs');
const { isAsyncFunction } = require('./function-kinds.cjs');
const { isRequestHandler } = require('./request-handlers.cjs');
const { isStandardArrayCall } = require('./repeated.cjs');
const { isTestSource } = require('./review-context.cjs');
const { prismaModelName } = require('./prisma.cjs');

const rule = 'floating-promise';
const chainMethods = new Set(['then', 'catch', 'finally']);
const nullishFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined;

function hasThenMethod(type) {
  const declarations = type.getProperty('then')?.declarations;
  return Boolean(
    declarations?.some(
      (declaration) =>
        declaration.kind === ts.SyntaxKind.MethodSignature || declaration.kind === ts.SyntaxKind.MethodDeclaration,
    ),
  );
}

// Promise, PromiseLike, ORM query promises and custom thenables; `any` has no `then` and stays quiet.
function isThenable(type) {
  if (!type.isUnion()) return hasThenMethod(type);
  const members = type.types.filter((member) => !(member.flags & (nullishFlags | ts.TypeFlags.Void)));
  return members.length > 0 && members.every(hasThenMethod);
}

function hasRejectionHandler(call, handlerIndex, checker) {
  const handler = call.arguments[handlerIndex];
  if (!handler) return false;
  if (ts.isSpreadElement(call.arguments[0]) || ts.isSpreadElement(handler)) return true;
  const value = ts.skipOuterExpressions(handler);
  if (value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value)) return false;
  const type = checker.getTypeAtLocation(value);
  return type.isUnion() ? type.types.some((member) => !(member.flags & nullishFlags)) : !(type.flags & nullishFlags);
}

// A rejection callback anywhere in the chain can own the failure. Missing and nullish callbacks pass it through.
function rejectionHandled(call, checker) {
  for (let current = call; ts.isCallExpression(current);) {
    const callee = skipParentheses(current.expression);
    if (!ts.isPropertyAccessExpression(callee) || !chainMethods.has(callee.name.text)) return false;
    if (callee.name.text === 'catch' && hasRejectionHandler(current, 0, checker)) return true;
    if (callee.name.text === 'then' && hasRejectionHandler(current, 1, checker)) return true;
    current = skipParentheses(callee.expression);
  }
  return false;
}

// A builder method that returns its own receiver type (supertest `.set()`, query-builder `.leftJoin()`) mutates
// the builder in place; the promise only matters once the builder itself is awaited.
function returnsReceiverType(call, checker) {
  const callee = skipParentheses(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || chainMethods.has(callee.name.text)) return false;
  const resultSymbol = checker.getTypeAtLocation(call).getSymbol();
  return Boolean(resultSymbol) && resultSymbol === checker.getTypeAtLocation(callee.expression).getSymbol();
}

function runsInAsyncOrHandler(node) {
  const owner = ts.findAncestor(node, ts.isFunctionLike);
  return Boolean(owner) && (isAsyncFunction(owner) || isRequestHandler(owner));
}

function isStatement(call) {
  let expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return ts.isExpressionStatement(expression.parent);
}

function awaitsInside(callback) {
  let found = false;
  (function visit(node) {
    if (found || (ts.isFunctionLike(node) && node !== callback)) return;
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) found = true;
    else ts.forEachChild(node, visit);
  })(callback);
  return found;
}

function asyncCallback(call) {
  const callback = call.arguments[0] && skipParentheses(call.arguments[0]);
  if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && isAsyncFunction(callback))
    return callback;
}

function isPrismaModelCall(call, checker) {
  const callee = skipParentheses(call.expression);
  return ts.isPropertyAccessExpression(callee) && Boolean(prismaModelName(callee.name, checker));
}

function throwsOutsideNestedFunctions(node) {
  let found = false;
  (function visit(child) {
    if (found || (child !== node && ts.isFunctionLike(child))) return;
    if (ts.isThrowStatement(child)) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

// A return inside the try that hands back a promise without awaiting it escapes the catch.
function returnsUnawaited(block, checker) {
  let found = false;
  (function visit(child) {
    if (found || ts.isFunctionLike(child)) return;
    if (
      ts.isReturnStatement(child) &&
      child.expression &&
      !ts.isAwaitExpression(skipParentheses(child.expression)) &&
      isThenable(checker.getTypeAtLocation(child.expression))
    )
      found = true;
    else ts.forEachChild(child, visit);
  })(block);
  return found;
}

function catchesWithoutRethrow(statement, checker) {
  return (
    ts.isTryStatement(statement) &&
    Boolean(statement.catchClause) &&
    !returnsUnawaited(statement.tryBlock, checker) &&
    !throwsOutsideNestedFunctions(statement.catchClause) &&
    !(statement.finallyBlock && throwsOutsideNestedFunctions(statement.finallyBlock))
  );
}

function containedByTryCatch(callee, checker) {
  const { body } = callee;
  if (!isAsyncFunction(callee) || !ts.isBlock(body) || body.statements.length !== 1) return false;
  return catchesWithoutRethrow(body.statements[0], checker);
}

function containedByCatchHandler(callee, checker) {
  let result = callee.body;
  if (ts.isBlock(result)) {
    const [statement] = result.statements;
    if (result.statements.length !== 1 || !ts.isReturnStatement(statement) || !statement.expression) return false;
    result = statement.expression;
  }
  result = skipParentheses(result);
  if (!ts.isCallExpression(result) || result.arguments.length !== 1) return false;
  const method = skipParentheses(result.expression);
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== 'catch') return false;
  const handler = skipParentheses(result.arguments[0]);
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
    if (throwsOutsideNestedFunctions(handler)) return false;
  } else if (!ts.isIdentifier(handler)) return false;
  // A handler whose result is itself a promise can reject the chain again.
  const signatures = checker.getTypeAtLocation(handler).getCallSignatures();
  return (
    signatures.length > 0 && signatures.every((signature) => !isThenable(checker.getReturnTypeOfSignature(signature)))
  );
}

function calleeImplementation(call, checker) {
  let symbol = checker.getSymbolAtLocation(skipParentheses(call.expression));
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declarations = symbol?.declarations;
  if (declarations?.length !== 1) return;
  const [declaration] = declarations;
  const implementation =
    ts.isVariableDeclaration(declaration) && declaration.initializer
      ? skipParentheses(declaration.initializer)
      : ts.isPropertyAssignment(declaration) && declaration.initializer
        ? skipParentheses(declaration.initializer)
        : declaration;
  if (
    (ts.isFunctionDeclaration(implementation) ||
      ts.isMethodDeclaration(implementation) ||
      ts.isArrowFunction(implementation) ||
      ts.isFunctionExpression(implementation)) &&
    implementation.body
  )
    return implementation;
}

function containsOwnFailures(call, checker) {
  const callee = calleeImplementation(call, checker);
  return Boolean(callee) && (containedByTryCatch(callee, checker) || containedByCatchHandler(callee, checker));
}

// `pubsub.publish(...)` / `eventBus.emit(...)` fan an event out to subscribers; callers deliberately do not wait on it.
const eventPublishMethods = new Set(['publish', 'emit', 'dispatch']);
const eventBusReceiverName = /pub-?sub|event-?bus|event-?emitter|message-?bus/i;

function isEventPublish(call) {
  const callee = skipParentheses(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !eventPublishMethods.has(callee.name.text)) return false;
  const receiver = skipParentheses(callee.expression);
  const receiverName = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : receiver.text;
  return typeof receiverName === 'string' && eventBusReceiverName.test(receiverName);
}

function contextualReason(call, checker) {
  if (isEventPublish(call))
    return 'Publishing to a pub/sub or event bus is usually deliberate fire-and-forget fan-out. Confirm a failed publish may go unnoticed.';
  return containsOwnFailures(call, checker)
    ? 'The called helper catches its own failures without rethrowing, so this is likely deliberate background work. Confirm the caller does not need it to finish first.'
    : undefined;
}

// `Promise.resolve()` or `Promise.resolve(value)` with a value that is not thenable cannot reject.
function resolvesWithoutRejection(call, checker) {
  const callee = skipParentheses(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'Promise' ||
    callee.name.text !== 'resolve'
  )
    return false;
  const [value] = call.arguments;
  return !value || !isThenable(checker.getTypeAtLocation(value));
}

function check(call, context) {
  if (isTestSource(call.getSourceFile().fileName) || !runsInAsyncOrHandler(call)) return;
  const name = calleeName(call, skipParentheses);
  if (name === 'forEach' && isStandardArrayCall(call, context.checker)) {
    const callback = asyncCallback(call);
    if (!callback || !awaitsInside(callback) || !isStatement(call)) return;
    context.report(
      ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call,
      rule,
      '`forEach` ignores the promises its async callback returns, so the loop does not wait for the awaits inside and a rejection can go unhandled. ' +
        'Use `await Promise.all(items.map(async (item) => ...))` to run them together, or a `for...of` loop with `await` to keep them in order.',
    );
    return;
  }
  if (!isStatement(call) || context.fireAndForgetNames.has(name)) return;
  if (
    resolvesWithoutRejection(call, context.checker) ||
    rejectionHandled(call, context.checker) ||
    returnsReceiverType(call, context.checker) ||
    !isThenable(context.checker.getTypeAtLocation(call))
  )
    return;
  if (isPrismaModelCall(call, context.checker)) {
    context.report(
      call,
      rule,
      `\`${name}()\` returns a lazy PrismaPromise, so this query never runs: Prisma sends it only when it is awaited or \`.then()\` is called, and \`void\` does not start it either. ` +
        'Await it, or return it to a caller that awaits it.',
    );
    return;
  }
  context.report(
    call,
    rule,
    `\`${name ?? 'This call'}()\` returns a promise that is neither awaited nor given a rejection handler. The caller carries on before the work is done, and a rejection can go unhandled. ` +
      'Await it, return it, or add `.catch(handler)`. For deliberate background work, mark it with `void` and handle failures with `.catch`, or list the helper under `fireAndForget` in the query policy.',
    contextualReason(call, context.checker),
  );
}

module.exports = { check };
