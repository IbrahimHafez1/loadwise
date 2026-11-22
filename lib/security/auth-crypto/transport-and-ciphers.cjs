'use strict';

// Disabled TLS verification and weak or misused ciphers.
const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('../../performance/compiler.cjs');
const { fileMentions, libraryFunction, resolveConstant, propertyKeyName, findProperty } = require('./shared.cjs');
const { enclosingBranches } = require('../exposure/literals.cjs');

const verificationOptions = new Set(['rejectUnauthorized', 'strictSSL']);
const tlsEnvironmentVariable = 'NODE_TLS_REJECT_UNAUTHORIZED';
const brokenCipher = /^(?:des|des-ede|rc4|rc2|bf)|-ecb$/i;
const cipherFunctions = new Set(['createCipher', 'createDecipher', 'createCipheriv', 'createDecipheriv']);
const tlsMessage =
  'TLS certificate verification is turned off. Enable verification, connect using a host name covered by the server certificate, and configure the trusted CA if it is private.';

// An operator opt-in such as `process.env.PG_SSL_ALLOW_SELF_SIGNED === 'true'` or `config.get('ALLOW_SELF_SIGNED')`.
const selfSignedOptIn = /ALLOW_SELF_SIGNED|ALLOW_INSECURE|ALLOW_UNAUTHORIZED|SKIP_TLS_VERIFY|INSECURE_SKIP_VERIFY/i;
// libpq `sslmode` values that encrypt without verifying the certificate.
const unverifiedSslModes = new Set(['require', 'prefer', 'allow', 'no-verify']);

// `mode === 'require' || mode === 'prefer'`: only comparisons of one value with unverified libpq modes.
function isUnverifiedSslModeTest(condition) {
  const comparisons = [];
  (function collect(node) {
    const expression = ts.skipOuterExpressions(node);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      collect(expression.left);
      collect(expression.right);
    } else comparisons.push(expression);
  })(condition);
  const comparedValues = new Set();
  for (const comparison of comparisons) {
    if (!ts.isBinaryExpression(comparison)) return false;
    const operator = comparison.operatorToken.kind;
    if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.EqualsEqualsToken)
      return false;
    const literal = ts.skipOuterExpressions(comparison.right);
    if (!ts.isStringLiteralLike(literal) || !unverifiedSslModes.has(literal.text)) return false;
    comparedValues.add(ts.skipOuterExpressions(comparison.left).getText());
  }
  return comparedValues.size === 1;
}

// The override is reached only through an explicit opt-in: a self-signed flag tested without negation or
// alternatives, or a branch for the libpq modes that by definition skip verification.
function isExplicitOptIn(node) {
  for (const { condition, branch } of enclosingBranches(node)) {
    if (branch !== 'true') continue;
    const text = condition.getText();
    if (selfSignedOptIn.test(text) && !/!|\|\|/.test(text)) return true;
    if (isUnverifiedSslModeTest(condition)) return true;
  }
  return false;
}

function reportTlsOverride(node, context, message = tlsMessage) {
  if (isExplicitOptIn(node)) return;
  if (context.fileContext.underNonProductionGuard(node))
    return context.report(node, 'tls-verification-disabled', message, 'Disabled only outside production.');
  context.report(node, 'tls-verification-disabled', message);
}

// mysql2's 3.16+ v3 client opts out of hostname checks unless verifyIdentity is explicitly enabled.
// An omitted option needs a known driver version; an explicit false is visible in the source itself.
function mysql2OmitsIdentityByDefault(sourceFile) {
  try {
    const manifest = require.resolve('mysql2/package.json', { paths: [path.dirname(sourceFile.fileName)] });
    const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const release = /^3\.(\d+)\.\d+$/.exec(version);
    return name === 'mysql2' && release && Number(release[1]) >= 16;
  } catch {
    return false;
  }
}

function inlineOptions(node) {
  const object = ts.skipOuterExpressions(node);
  if (!ts.isObjectLiteralExpression(object)) return;
  const names = new Set();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    const name = propertyKeyName(property.name);
    if (name === undefined || name === '__proto__' || names.has(name)) return;
    names.add(name);
  }
  return object;
}

function explicitlyFalse(property) {
  return (
    property &&
    ts.isPropertyAssignment(property) &&
    ts.skipOuterExpressions(property.initializer).kind === ts.SyntaxKind.FalseKeyword
  );
}

function checkMysqlTls(call, context) {
  if (!call.arguments[0] || !fileMentions(context.sourceFile, ['mysql2'])) return;
  const options = inlineOptions(call.arguments[0]);
  const ssl = options && findProperty(options, 'ssl');
  if (!ssl || !ts.isPropertyAssignment(ssl)) return;
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(ts.skipOuterExpressions(callee.expression))) return;
  const factory = libraryFunction(call, context, ['mysql2', 'mysql2/promise']);
  if (factory !== 'createConnection' && factory !== 'createPool') return;
  const value = ts.skipOuterExpressions(ssl.initializer);
  for (const branch of ts.isConditionalExpression(value) ? [value.whenTrue, value.whenFalse] : [value]) {
    const tls = inlineOptions(branch);
    if (!tls) continue;
    if (explicitlyFalse(findProperty(tls, 'rejectUnauthorized'))) continue;
    const identity = findProperty(tls, 'verifyIdentity');
    if (identity ? !explicitlyFalse(identity) : !mysql2OmitsIdentityByDefault(context.sourceFile)) continue;
    reportTlsOverride(
      identity ?? tls,
      context,
      'This mysql2 TLS configuration skips server hostname verification. Check that the database hostname matches its trusted certificate before enabling ssl.verifyIdentity.',
    );
  }
}

function checkTlsProperty(property, context) {
  if (!verificationOptions.has(propertyKeyName(property.name) ?? '')) return;
  if (ts.skipOuterExpressions(property.initializer).kind === ts.SyntaxKind.FalseKeyword)
    reportTlsOverride(property, context);
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

module.exports = { checkTlsProperty, checkTlsAssignment, checkMysqlTls, checkCipher };
