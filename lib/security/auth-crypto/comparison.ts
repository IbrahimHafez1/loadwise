// Secrets compared with ===, which stops at the first differing character.
import { ts } from '../../performance/compiler.js';
import { fileMentions, libraryFunction, resolveConstant, lastSegment } from './shared.js';
import type { BinaryExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter, SecurityRuleContext } from '../../shared/types.js';

const timingSafeStringComparison = Symbol('timingSafeStringComparison');
const strictComparisons = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);
const comparisonOperators = new Set([
  ...strictComparisons,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const secretName = /(?:signature|hmac|digest|secret|apiKey|api_key|token|otp|password|passwordHash|csrf)$/i;
const message =
  'This compares a secret with `===`, which stops at the first differing character and leaks timing. Compare with `crypto.timingSafeEqual` on equal-length buffers.';

const bareTokenReason = 'The compared value is a bare `token`, which may be an identifier rather than a secret.';

function isStringOperand(node: Node, checker: CheckerAdapter) {
  const type = checker.getTypeAtLocation(node);
  const alternatives = type.isUnion() && type.types ? type.types : [type];
  return alternatives.every((alternative) => Boolean(alternative.flags & ts.TypeFlags.StringLike));
}

// `FieldType.SIGNATURE`: an enum or constant-table member is a label, whatever its name says.
function isConstantMember(expression: Expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    /^[A-Z]/.test(expression.expression.text) &&
    /^[A-Z]/.test(expression.name.text)
  );
}

function isConstantOperand(node: Expression) {
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

function hasSecretName(node: Node) {
  const name = lastSegment(node);
  return name !== undefined && secretName.test(name);
}

// `createHmac(...).update(...).digest('hex')`, directly or through a const.
function isDigestOfHash(node: Expression, context: SecurityRuleContext) {
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

function checkSecretComparison(comparison: BinaryExpression, context: SecurityRuleContext) {
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
    const canFix =
      !ambiguous &&
      strictComparisons.has(comparison.operatorToken.kind) &&
      isStringOperand(left, context.checker) &&
      isStringOperand(right, context.checker);
    return context.report(
      comparison,
      'secret-compared-non-constant-time',
      message,
      ambiguous ? bareTokenReason : undefined,
      {
        taint: traced,
        // The syntax-only fix builder must have the compiler's proof for this exact comparison.
        ...(canFix && { [timingSafeStringComparison]: comparison.getText() }),
      },
    );
  }
}

export { checkSecretComparison, timingSafeStringComparison };
