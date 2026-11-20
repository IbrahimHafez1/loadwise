'use strict';

const { ts, calleeCall, indentationAt } = require('./helpers.cjs');
const { describeCall, skipParentheses } = require('../http-timeouts.cjs');

const limitSource = { signal: 'signal: AbortSignal.timeout(10_000)', timeout: 'timeout: 10_000' };
const placeholderNote = 'The 10 s limit is a placeholder; tune it to the slowest response this API should ever take.';

function spansLines(text, from, to) {
  return text.slice(from, to).includes('\n');
}

// Adds `property` to an object literal, on its own line when the literal is already multi-line.
function addProperty(literal, property, text) {
  const [last] = literal.properties.slice(-1);
  if (!last) return { start: literal.getStart(), end: literal.end, text: `{ ${property} }` };
  const trailingComma = literal.properties.hasTrailingComma;
  const multiline = spansLines(text, literal.getStart(), last.getStart());
  const commaEnd = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
  if (multiline) {
    const indentation = indentationAt(text, last.getStart());
    const lineText = `\n${indentation}${property}`;
    return { start: commaEnd, end: commaEnd, text: trailingComma ? `${lineText},` : `,${lineText}` };
  }
  return { start: commaEnd, end: commaEnd, text: trailingComma ? ` ${property},` : `, ${property}` };
}

// Appends `{ property }` as a new last argument.
function addOptionsArgument(call, property, text) {
  const [last] = call.arguments.slice(-1);
  const trailingComma = call.arguments.hasTrailingComma;
  const commaEnd = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
  const options = `{ ${property} }`;
  if (spansLines(text, call.expression.end, last.getStart())) {
    const lineText = `\n${indentationAt(text, last.getStart())}${options}`;
    return { start: commaEnd, end: commaEnd, text: trailingComma ? `${lineText},` : `,${lineText}` };
  }
  return { start: commaEnd, end: commaEnd, text: trailingComma ? ` ${options},` : `, ${options}` };
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
    return { edits: [addProperty(literal, property, text)], note: placeholderNote };
  }
  if (call.arguments.length !== target.optionsIndex) return;
  return { edits: [addOptionsArgument(call, property, text)], note: placeholderNote };
}

module.exports = { 'http-call-without-timeout': timeoutFix };
