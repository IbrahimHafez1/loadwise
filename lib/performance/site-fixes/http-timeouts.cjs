'use strict';

const { ts, calleeCall, addProperty, addOptionsArgument } = require('./helpers.cjs');
const { describeCall, skipParentheses } = require('../http-timeouts.cjs');

const limitSource = { signal: 'signal: AbortSignal.timeout(10_000)', timeout: 'timeout: 10_000' };
const placeholderNote = 'The 10 s limit is a placeholder; tune it to the slowest response this API should ever take.';

function timeoutFix({ node, text }) {
  const call = calleeCall(node);
  const target = call && describeCall(call);
  if (!target) return;
  const property = limitSource[target.limitProperty];
  const options = call.arguments[target.optionsIndex];
  if (options) {
    const literal = skipParentheses(options);
    if (!ts.isObjectLiteralExpression(literal)) return;
    return { edits: [addProperty(literal, property, text)], note: placeholderNote };
  }
  if (call.arguments.length !== target.optionsIndex) return;
  return { edits: [addOptionsArgument(call, property, text)], note: placeholderNote };
}

module.exports = { 'http-call-without-timeout': timeoutFix };
