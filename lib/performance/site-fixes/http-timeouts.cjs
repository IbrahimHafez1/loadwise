'use strict';

const { ts, calleeCall, addProperty, addOptionsArgument } = require('./helpers.cjs');
const { describeCall, skipParentheses } = require('../http-timeouts.cjs');

const limitSource = { signal: 'signal: AbortSignal.timeout(10_000)', timeout: 'timeout: 10_000' };
const placeholderNote = 'The 10 s limit is a placeholder; tune it to the slowest response this API should ever take.';
const slowWorkNote =
  'This request sends a body or targets a long-running endpoint (upload, inference, export), so a 10 s limit can abort work that normally succeeds. ' +
  'Set the limit from the slowest response this endpoint should ever take.';
const longRunningUrl = /upload|predict|infer|export|import|download|backup|transcod|render|stream/i;
const bodyArgumentIndex = 1;

function hasProperty(literal, names) {
  return literal.properties.some(
    (property) =>
      property.name &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      names.includes(property.name.text),
  );
}

// Uploads, inference, exports and other writes can legitimately take longer than the placeholder limit.
function mayRunLong(call, target, literal) {
  if (literal && hasProperty(literal, ['body', 'data'])) return true;
  if (
    target.library === 'axios' &&
    target.optionsIndex > bodyArgumentIndex &&
    call.arguments.length > bodyArgumentIndex
  ) {
    return true;
  }
  const [url] = call.arguments;
  return !!url && longRunningUrl.test(url.getText());
}

function withReview(edit, call, target, literal) {
  if (!mayRunLong(call, target, literal)) return { edits: [edit], note: placeholderNote };
  return { edits: [edit], note: slowWorkNote, requiresReview: true };
}

function timeoutFix({ node, text }) {
  const call = calleeCall(node);
  const target = call && describeCall(call);
  if (!target) return;
  const property = limitSource[target.limitProperty];
  const options = call.arguments[target.optionsIndex];
  if (options) {
    const literal = skipParentheses(options);
    if (!ts.isObjectLiteralExpression(literal)) return;
    return withReview(addProperty(literal, property, text), call, target, literal);
  }
  if (call.arguments.length !== target.optionsIndex) return;
  return withReview(addOptionsArgument(call, property, text), call, target);
}

module.exports = { 'http-call-without-timeout': timeoutFix };
