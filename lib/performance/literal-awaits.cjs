'use strict';

const { skipParentheses } = require('./call-syntax.cjs');
const { syntax: ts } = require('./compiler.cjs');

const rule = 'serial-awaits-in-literal';

// The expression slots of a literal: array elements or object property values.
function valuesOf(literal) {
  if (ts.isArrayLiteralExpression(literal)) return literal.elements;
  return literal.properties.map((property) => (ts.isPropertyAssignment(property) ? property.initializer : property));
}

function directAwaits(literal) {
  return valuesOf(literal)
    .map(skipParentheses)
    .filter((value) => ts.isAwaitExpression(value));
}

const writeOperators = new Set([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]);

function writesSomething(literal) {
  let writes = false;
  (function visit(node) {
    if (writes) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment) {
      if (node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) writes = true;
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      writeOperators.has(node.operator)
    ) {
      writes = true;
    }
    ts.forEachChild(node, visit);
  })(literal);
  return writes;
}

// The array or object literal whose direct value is `await <call>`, when `call` is the awaited operand.
function literalAwaiting(call) {
  let current = call.parent;
  while (ts.isParenthesizedExpression(current)) current = current.parent;
  if (!ts.isAwaitExpression(current) || skipParentheses(current.expression) !== call) return;
  let slot = current.parent;
  while (ts.isParenthesizedExpression(slot)) slot = slot.parent;
  if (ts.isPropertyAssignment(slot)) slot = slot.parent;
  if (ts.isArrayLiteralExpression(slot) || ts.isObjectLiteralExpression(slot))
    return { literal: slot, awaited: current };
}

const combinators = new Set(['all', 'allSettled', 'race', 'any']);

// promise-combinator-serial-await already reports `Promise.all([await a(), await b()])`.
function isCombinatorArgument(literal) {
  let parent = literal.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (!ts.isCallExpression(parent) || !parent.arguments.includes(literal)) return false;
  const callee = skipParentheses(parent.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Promise' &&
    combinators.has(callee.name.text)
  );
}

const transactionMethods = new Set(['transaction', '$transaction']);

// The client parameter of the transaction callback that encloses `node`, such as `manager` in
// `dataSource.transaction(async (manager) => ...)`.
function transactionClientName(node) {
  const callback = ts.findAncestor(node, ts.isFunctionLike);
  const owner = callback?.parent;
  if (!owner || !ts.isCallExpression(owner) || !owner.arguments.includes(callback)) return;
  const callee = skipParentheses(owner.expression);
  if (!ts.isPropertyAccessExpression(callee) || !transactionMethods.has(callee.name.text)) return;
  const [client] = callback.parameters;
  return client && ts.isIdentifier(client.name) ? client.name.text : undefined;
}

// Calls that all run on one transaction client share a single connection, so Promise.all cannot overlap them.
function sharesTransactionClient(literal, awaits) {
  const client = transactionClientName(literal);
  if (!client) return false;
  return awaits.every((awaited) => {
    const call = skipParentheses(awaited.expression);
    if (!ts.isCallExpression(call)) return false;
    if (call.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === client)) return true;
    let receiver = skipParentheses(call.expression);
    while (
      ts.isPropertyAccessExpression(receiver) ||
      ts.isElementAccessExpression(receiver) ||
      ts.isCallExpression(receiver)
    )
      receiver = skipParentheses(receiver.expression);
    return ts.isIdentifier(receiver) && receiver.text === client;
  });
}

function check(call, context) {
  const found = literalAwaiting(call);
  if (!found || isCombinatorArgument(found.literal)) return;
  const awaits = directAwaits(found.literal);
  if (awaits.length < 2 || awaits[1] !== found.awaited || writesSomething(found.literal)) return;
  if (sharesTransactionClient(found.literal, awaits)) return;
  const shape = ts.isArrayLiteralExpression(found.literal) ? 'array' : 'object';
  context.report(
    call,
    rule,
    `This ${shape} literal awaits ${awaits.length} values one after another, so it looks parallel but takes the sum of all the waits instead of the slowest one. ` +
      'Independent calls can overlap with `await Promise.all([...])`. Verify that their resources support concurrency and that later calls may start even if an earlier one fails.',
  );
}

module.exports = { check, literalAwaiting, directAwaits, skipParentheses };
