'use strict';

// Disabled TLS verification and weak or misused ciphers.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { fileMentions, libraryFunction, resolveConstant, propertyKeyName } = require('./shared.cjs');

const verificationOptions = new Set(['rejectUnauthorized', 'strictSSL']);
const tlsEnvironmentVariable = 'NODE_TLS_REJECT_UNAUTHORIZED';
const brokenCipher = /^(?:des|des-ede|rc4|rc2|bf)|-ecb$/i;
const cipherFunctions = new Set(['createCipher', 'createDecipher', 'createCipheriv', 'createDecipheriv']);
const tlsMessage =
  'TLS certificate verification is turned off, so this connection accepts any certificate and can be intercepted. Remove the override and supply the CA with `ca` if the server uses a private one.';

function reportTlsOverride(node, context) {
  if (context.fileContext.underNonProductionGuard(node))
    return context.report(node, 'tls-verification-disabled', tlsMessage, 'Disabled only outside production.');
  context.report(node, 'tls-verification-disabled', tlsMessage);
}

function checkTlsProperty(property, context) {
  if (!verificationOptions.has(propertyKeyName(property.name) ?? '')) return;
  if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) reportTlsOverride(property, context);
}

function environmentVariableName(target) {
  const expression = ts.skipOuterExpressions(target);
  const access = ts.isPropertyAccessExpression(expression)
    ? { object: expression.expression, key: expression.name.text }
    : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)
      ? { object: expression.expression, key: expression.argumentExpression.text }
      : undefined;
  return access && /^process\.env$/.test(access.object.getText()) ? access.key : undefined;
}

function isZero(node) {
  const value = ts.skipOuterExpressions(node);
  return (
    (ts.isStringLiteralLike(value) && value.text === '0') || (ts.isNumericLiteral(value) && Number(value.text) === 0)
  );
}

function checkTlsAssignment(assignment, context) {
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const target = ts.skipOuterExpressions(assignment.left);
  if (environmentVariableName(target) === tlsEnvironmentVariable) {
    if (isZero(assignment.right)) reportTlsOverride(assignment, context);
    return;
  }
  if (
    ts.isPropertyAccessExpression(target) &&
    verificationOptions.has(target.name.text) &&
    ts.skipOuterExpressions(assignment.right).kind === ts.SyntaxKind.FalseKeyword
  )
    reportTlsOverride(assignment, context);
}

// A fixed IV: a string literal, `Buffer.alloc(...)`, or `Buffer.from(<literal>, ...)`.
function isStaticInitializationVector(node, context) {
  const value = resolveConstant(node, context.checker);
  if (ts.isStringLiteralLike(value)) return true;
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  const { expression: receiver, name } = value.expression;
  if (!ts.isIdentifier(receiver) || receiver.text !== 'Buffer') return false;
  if (name.text === 'alloc') return true;
  const source = value.arguments[0] && ts.skipOuterExpressions(value.arguments[0]);
  return (
    name.text === 'from' &&
    Boolean(source) &&
    (ts.isStringLiteralLike(source) ||
      (ts.isArrayLiteralExpression(source) && source.elements.every((element) => ts.isNumericLiteral(element))))
  );
}

function weaknessOf(name, call, context) {
  if (name === 'createCipher' || name === 'createDecipher')
    return 'the deprecated `' + name + '` derives its key without a salt and uses no IV';
  const algorithmNode = call.arguments[0] && resolveConstant(call.arguments[0], context.checker);
  const algorithm = algorithmNode && ts.isStringLiteralLike(algorithmNode) ? algorithmNode.text : undefined;
  if (algorithm && brokenCipher.test(algorithm))
    return /-ecb$/i.test(algorithm)
      ? 'ECB mode encrypts equal blocks to equal output'
      : `${algorithm} is a broken or outdated cipher`;
  if (call.arguments[2] && isStaticInitializationVector(call.arguments[2], context))
    return 'a fixed IV makes equal messages encrypt identically';
}

function checkCipher(call, context) {
  if (!fileMentions(context.sourceFile, ['crypto'])) return;
  const name = libraryFunction(call, context, ['crypto']);
  if (!name || !cipherFunctions.has(name)) return;
  const reason = weaknessOf(name, call, context);
  if (reason)
    context.report(
      call,
      'insecure-cipher',
      `This cipher setup is weak (${reason}). Use \`aes-256-gcm\` with a random 12-byte IV per message.`,
    );
}

module.exports = { checkTlsProperty, checkTlsAssignment, checkCipher };
