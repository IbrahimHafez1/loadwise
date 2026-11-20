'use strict';

const { syntax: ts } = require('./compiler.cjs');

const rule = 'serial-awaits-in-literal';

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

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

function check(call, context) {
  const found = literalAwaiting(call);
  if (!found || isCombinatorArgument(found.literal)) return;
  const awaits = directAwaits(found.literal);
  if (awaits.length < 2 || awaits[1] !== found.awaited || writesSomething(found.literal)) return;
  const shape = ts.isArrayLiteralExpression(found.literal) ? 'array' : 'object';
  context.report(
    call,
    rule,
    `This ${shape} literal awaits ${awaits.length} values one after another, so it looks parallel but takes the sum of all the waits instead of the slowest one. ` +
      'Start the calls together with `await Promise.all([...])` and use the results. ' +
      'Keep it serial only when a later call needs the side effects of an earlier one, since Promise.all starts them all at once.',
  );
}

module.exports = { check, literalAwaiting, directAwaits, skipParentheses };
