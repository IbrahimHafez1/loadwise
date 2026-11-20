'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { isAsyncFunction, isRequestHandler } = require('./password-hashing.cjs');
const { isStandardArrayCall } = require('./repeated.cjs');
const { isTestSource } = require('./review-context.cjs');
const { prismaModelName } = require('./prisma.cjs');

const rule = 'floating-promise';
const chainMethods = new Set(['then', 'catch', 'finally']);
const nullishFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

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
  const members = type.types.filter((member) => !(member.flags & nullishFlags));
  return members.length > 0 && members.every(hasThenMethod);
}

// `.catch(handler)` or `.then(onFulfilled, onRejected)` anywhere in the chain means a rejection has an owner.
function rejectionHandled(call) {
  for (let current = call; ts.isCallExpression(current);) {
    const callee = skipParentheses(current.expression);
    if (!ts.isPropertyAccessExpression(callee) || !chainMethods.has(callee.name.text)) return false;
    if (callee.name.text === 'catch' || (callee.name.text === 'then' && current.arguments.length >= 2)) return true;
    current = skipParentheses(callee.expression);
  }
  return false;
}

function calleeName(call) {
  const callee = skipParentheses(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
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
  const name = calleeName(call);
  if (name === 'forEach' && isStandardArrayCall(call, context.checker)) {
    const callback = asyncCallback(call);
    if (!callback || !awaitsInside(callback) || !isStatement(call)) return;
    context.report(
      ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call,
      rule,
      '`forEach` ignores the promises its async callback returns, so the loop finishes at once, the awaits inside run unsupervised and a failure becomes an unhandled rejection. ' +
        'Use `await Promise.all(items.map(async (item) => ...))` to run them together, or a `for...of` loop with `await` to keep them in order.',
    );
    return;
  }
  if (!isStatement(call) || context.fireAndForgetNames.has(name)) return;
  if (
    rejectionHandled(call) ||
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
    `\`${name ?? 'This call'}()\` returns a promise that is neither awaited nor given a rejection handler, so a failure becomes an unhandled rejection (which stops Node by default) and the caller carries on before the work is done. ` +
      'Await it, return it, or add `.catch(handler)`. For deliberate background work, mark it with `void` and handle failures with `.catch`, or list the helper under `fireAndForget` in the query policy.',
  );
}

module.exports = { check };
