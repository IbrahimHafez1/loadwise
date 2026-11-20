'use strict';

// Math.random() output that ends up as a token, code or secret.
const { syntax: ts } = require('../../performance/compiler.cjs');
const {
  propertyKeyName,
  lastSegment,
  nameWords,
  enclosingFunction,
  functionName,
  referencesOf,
} = require('./shared.cjs');

const secretSubstrings = /token|secret|password|passwd|nonce|session|apiKey|resetCode|verif|invite|coupon|csrf/i;
// Short words that appear inside unrelated names (`mapping`, `footprint`, `asalt`), so they must be whole words.
const secretWords = new Set(['pin', 'otp', 'salt']);
const harmlessName = /jitter|delay|backoff|retry|sample|shuffle|color|index|offset|percent/i;
const identifierName = /^id$|[a-z0-9]Id$/;
const valueCarryingMathFunctions = new Set(['floor', 'round', 'ceil', 'trunc', 'abs']);
const valueCarryingConversions = new Set(['String', 'Number', 'parseInt', 'parseFloat', 'BigInt']);
const valueCarryingStringMethods = new Set([
  'toString',
  'substring',
  'substr',
  'slice',
  'toFixed',
  'toUpperCase',
  'toLowerCase',
  'padStart',
  'padEnd',
  'replace',
  'concat',
]);
const carryingOperators = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const followDepthLimit = 2;
const message =
  '`Math.random()` is predictable and must not produce tokens, codes or secrets. Use `crypto.randomBytes`, `crypto.randomInt` or `crypto.randomUUID`.';

function isMathRandomCall(node) {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'random' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Math'
  );
}

function classifyName(name) {
  if (!name || harmlessName.test(name)) return;
  if (secretSubstrings.test(name) || nameWords(name).some((word) => secretWords.has(word))) return 'secret';
  if (identifierName.test(name)) return 'identifier';
}

// Walks outward while the random value is still part of the result, and returns the names where it lands.
function landingNames(start, context, depth = 0) {
  const names = [];
  let current = start;
  for (;;) {
    const parent = current.parent;
    if (!parent) return names;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent)
    ) {
      current = parent;
    } else if (ts.isBinaryExpression(parent)) {
      if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (parent.right === current) names.push(lastSegment(parent.left));
        return names;
      }
      if (!carryingOperators.has(parent.operatorToken.kind)) return names;
      current = parent;
    } else if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      const call = parent.parent;
      if (!ts.isCallExpression(call) || call.expression !== parent || !valueCarryingStringMethods.has(parent.name.text))
        return names;
      current = call;
    } else if (ts.isCallExpression(parent) && parent.arguments.includes(current)) {
      const callee = ts.skipOuterExpressions(parent.expression);
      const carries = ts.isPropertyAccessExpression(callee)
        ? ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'Math' &&
          valueCarryingMathFunctions.has(callee.name.text)
        : ts.isIdentifier(callee) && valueCarryingConversions.has(callee.text);
      if (!carries) return names;
      current = parent;
    } else if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      names.push(propertyKeyName(parent.name));
      return names;
    } else if (ts.isParameter(parent) && parent.initializer === current) {
      names.push(ts.isIdentifier(parent.name) ? parent.name.text : undefined);
      return names;
    } else if (ts.isVariableDeclaration(parent)) {
      if (!ts.isIdentifier(parent.name)) return names;
      names.push(parent.name.text);
      if (depth >= followDepthLimit) return names;
      const scope = enclosingFunction(parent) ?? context.sourceFile;
      for (const reference of referencesOf(parent.name, scope, context.checker))
        names.push(...landingNames(reference, context, depth + 1));
      return names;
    } else if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === current)) {
      const fn = ts.isReturnStatement(parent) ? enclosingFunction(parent) : parent;
      names.push(fn && functionName(fn));
      return names;
    } else return names;
  }
}

function checkMathRandom(call, context) {
  if (!isMathRandomCall(call)) return;
  const classes = landingNames(call, context).map(classifyName);
  if (classes.includes('secret')) return context.report(call, 'insecure-random-for-secret', message);
  if (classes.includes('identifier'))
    context.report(
      call,
      'insecure-random-for-secret',
      message,
      'The value is only used as an identifier; confirm it is not a secret or capability.',
    );
}

module.exports = { checkMathRandom };
