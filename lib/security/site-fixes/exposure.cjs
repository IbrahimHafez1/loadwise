'use strict';

// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see lib/performance/site-fix.cjs.
const { ts, ancestor, calleeCall, indentationAt, replaceNode } = require('../../performance/site-fixes/helpers.cjs');
const { unwrap, findProperty, isFullyLiteral, isFalse, isTrue } = require('../exposure/literals.cjs');

const cookieMethods = new Set(['cookie', 'setCookie']);
const nonProductionCheck = "process.env.NODE_ENV !== 'production'";
const whitelistNote =
  'With whitelist enabled, DTO properties that carry no validation decorator are stripped from the request. Check each DTO before applying.';

function spansLines(text, from, to) {
  return text.slice(from, to).includes('\n');
}

// Adds `property` to an object literal, on its own line when the literal is already multi-line.
function addProperty(literal, property, text) {
  const [last] = literal.properties.slice(-1);
  if (!last) return { start: literal.getStart(), end: literal.end, text: `{ ${property} }` };
  const trailingComma = literal.properties.hasTrailingComma;
  const commaEnd = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
  if (spansLines(text, literal.getStart(), last.getStart())) {
    const lineText = `\n${indentationAt(text, last.getStart())}${property}`;
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

function cookieFix({ node, text }) {
  const call = calleeCall(node);
  const callee = call && unwrap(call.expression);
  if (!callee || !ts.isPropertyAccessExpression(callee) || !cookieMethods.has(callee.name.text)) return;
  const options = call.arguments[2] && unwrap(call.arguments[2]);
  if (!options && call.arguments.length === 2) return { edits: [addOptionsArgument(call, 'httpOnly: true', text)] };
  if (!options || !ts.isObjectLiteralExpression(options) || !isFullyLiteral(options)) return;
  if (findProperty(options, 'httpOnly')) return;
  return { edits: [addProperty(options, 'httpOnly: true', text)] };
}

function validationPipeFix({ node, text }) {
  const pipe = ancestor(node, ts.isNewExpression);
  if (!pipe || !pipe.arguments) return;
  if (!pipe.arguments.length) {
    const insertAt = pipe.end - 1;
    return { edits: [{ start: insertAt, end: insertAt, text: '{ whitelist: true }' }], note: whitelistNote };
  }
  const options = unwrap(pipe.arguments[0]);
  if (!ts.isObjectLiteralExpression(options) || !isFullyLiteral(options)) return;
  const whitelist = findProperty(options, 'whitelist');
  if (!whitelist) return { edits: [addProperty(options, 'whitelist: true', text)], note: whitelistNote };
  if (!isFalse(whitelist.value)) return;
  return { edits: [replaceNode(whitelist.value, 'true')], note: whitelistNote };
}

function graphqlFix({ node }) {
  const property = ancestor(node, ts.isPropertyAssignment);
  const value = property && unwrap(property.initializer);
  if (!isTrue(value)) return;
  return { edits: [replaceNode(value, nonProductionCheck)] };
}

module.exports = {
  'cookie-missing-security-flags': cookieFix,
  'graphql-introspection-enabled': graphqlFix,
  'nest-validation-without-whitelist': validationPipeFix,
};
