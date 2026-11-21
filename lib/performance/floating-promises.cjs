'use strict';

const { calleeName, skipParentheses } = require('./call-syntax.cjs');
const { syntax: ts } = require('./compiler.cjs');
const { isAsyncFunction, isRequestHandler } = require('./password-hashing.cjs');
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
  );
}

module.exports = { check };
