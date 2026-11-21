'use strict';

// `regex-from-input`: request text compiled as a regular expression, by `RegExp`, by a string method that converts
// its argument to a pattern, or as a MongoDB `$regex` operand.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { reportTraced, isGlobalName, methodName, initializerOf } = require('./shared.cjs');

const ruleId = 'regex-from-input';
const regexConstructors = new Set(['RegExp']);
const patternMethods = new Set(['match', 'matchAll', 'search']);
const maxAliasDepth = 4;

function message(label) {
  return `This regular expression is built from \`${label}\`; a crafted pattern can block the event loop (ReDoS) or match more than intended. Escape the input before building the pattern or use a literal comparison.`;
}

// The classic escape `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` somewhere in the value or the `const` it names.
// The taint engine propagates through `replace`, so this escape is recognised here.
function isEscaped(expression, checker, depth = 0) {
  if (!expression || depth > maxAliasDepth) return false;
  return Boolean(
    (function visit(node) {
      if (ts.isIdentifier(node)) return isEscaped(initializerOf(node, checker), checker, depth + 1);
      if (
        ts.isCallExpression(node) &&
        methodName(node) === 'replace' &&
        node.arguments[0]?.kind === ts.SyntaxKind.RegularExpressionLiteral &&
        node.arguments[1] &&
        ts.isStringLiteralLike(node.arguments[1]) &&
        node.arguments[1].text.includes('$&')
      )
        return true;
      return ts.forEachChild(node, visit);
    })(expression),
  );
}

function reportPattern(pattern, context) {
  if (!pattern || ts.isSpreadElement(pattern) || ts.isStringLiteralLike(pattern)) return;
  const trace = context.taint.trace(pattern, 'regex');
  if (!trace || isEscaped(pattern, context.checker)) return;
  reportTraced(context, pattern, ruleId, message(trace.label), trace);
}

function isStringReceiver(call, checker) {
  const receiver = ts.skipOuterExpressions(call.expression).expression;
  return Boolean(checker.getTypeAtLocation(receiver).flags & ts.TypeFlags.StringLike);
}

function checkCall(node, context) {
  const callee = ts.skipOuterExpressions(node.expression);
  if (isGlobalName(callee, regexConstructors, context.checker)) return reportPattern(node.arguments?.[0], context);
  if (!ts.isCallExpression(node) || !patternMethods.has(methodName(node))) return;
  const [pattern] = node.arguments;
  if (!pattern || !isStringReceiver(node, context.checker)) return;
  // A RegExp object built elsewhere is reported where it is built.
  if (
    !(
      context.checker.getTypeAtLocation(pattern).flags &
      (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)
    )
  )
    return;
  reportPattern(pattern, context);
}

function checkRegexOperator(property, context) {
  if (property.name.getText().replace(/['"]/g, '') !== '$regex') return;
  reportPattern(property.initializer, context);
}

module.exports = { checkCall, checkRegexOperator };
