'use strict';

// Secrets compared with ===, which stops at the first differing character.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { fileMentions, libraryFunction, resolveConstant, lastSegment } = require('./shared.cjs');

const comparisonOperators = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const secretName = /(?:signature|hmac|digest|secret|apiKey|api_key|token|otp|password|passwordHash|csrf)$/i;
const message =
  'This compares a secret with `===`, which stops at the first differing character and leaks timing. Compare with `crypto.timingSafeEqual` on equal-length buffers.';

const bareTokenReason = 'The compared value is a bare `token`, which may be an identifier rather than a secret.';

// `FieldType.SIGNATURE`: an enum or constant-table member is a label, whatever its name says.
function isConstantMember(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    /^[A-Z]/.test(expression.expression.text) &&
    /^[A-Z]/.test(expression.name.text)
  );
}

function isConstantOperand(node) {
  const expression = ts.skipOuterExpressions(node);
  return (
    isConstantMember(expression) ||
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isTypeOfExpression(expression) ||
    ts.isVoidExpression(expression) ||
    (ts.isIdentifier(expression) && expression.text === 'undefined') ||
    [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(expression.kind)
  );
}

function hasSecretName(node) {
  const name = lastSegment(node);
  return Boolean(name) && secretName.test(name);
}

// `createHmac(...).update(...).digest('hex')`, directly or through a const.
function isDigestOfHash(node, context) {
  let current = resolveConstant(node, context.checker);
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return false;
  if (current.expression.name.text !== 'digest') return false;
  while (ts.isCallExpression(current)) {
    const name = libraryFunction(current, context, ['crypto']);
    if (name === 'createHmac' || name === 'createHash') return true;
    const callee = ts.skipOuterExpressions(current.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    current = ts.skipOuterExpressions(callee.expression);
  }
  return false;
}

function checkSecretComparison(comparison, context) {
  if (!comparisonOperators.has(comparison.operatorToken.kind)) return;
  const { left, right } = comparison;
  if (isConstantOperand(left) || isConstantOperand(right)) return;
  const candidates = [
    [left, right],
    [right, left],
  ];
  for (const [secret, supplied] of candidates) {
    const hashed = fileMentions(context.sourceFile, ['crypto']) && isDigestOfHash(secret, context);
    if (!hashed && !hasSecretName(secret)) continue;
    const traced = context.taint.trace(supplied, 'html');
    if (!traced || context.taint.trace(secret, 'html')) continue;
    const ambiguous = !hashed && lastSegment(secret) === 'token';
    return context.report(
      comparison,
      'secret-compared-non-constant-time',
      message,
      ambiguous ? bareTokenReason : undefined,
      {
        taint: traced,
      },
    );
  }
}

module.exports = { checkSecretComparison };
