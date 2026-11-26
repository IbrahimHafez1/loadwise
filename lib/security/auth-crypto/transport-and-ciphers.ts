// Disabled TLS verification and weak or misused ciphers.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ts } from '../../performance/compiler.js';
import { noteUnreadable } from '../../shared/coverage-notes.js';
import { fileMentions, libraryFunction, resolveConstant, propertyKeyName, findProperty } from './shared.js';
import { enclosingBranches } from '../exposure/literals.js';
import type {
  BinaryExpression,
  CallExpression,
  Expression,
  Node,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  SourceFile,
} from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const verificationOptions = new Set(['rejectUnauthorized', 'strictSSL']);
const tlsEnvironmentVariable = 'NODE_TLS_REJECT_UNAUTHORIZED';
const brokenCipher = /^(?:des|des-ede|rc4|rc2|bf)|-ecb$/i;
const cipherFunctions = new Set(['createCipher', 'createDecipher', 'createCipheriv', 'createDecipheriv']);
const tlsMessage =
  'TLS certificate verification is turned off. Enable verification, connect using a host name covered by the server certificate, and configure the trusted CA if it is private.';

// An operator opt-in such as `process.env.PG_SSL_ALLOW_SELF_SIGNED === 'true'` or
// `config.get('ALLOW_SELF_SIGNED')`.
const selfSignedOptIn =
  /ALLOW_SELF_SIGNED|ALLOW_INSECURE|ALLOW_UNAUTHORIZED|SKIP_TLS_VERIFY|INSECURE_SKIP_VERIFY|IGNORE_SSL|IGNORE_TLS|ACCEPT_INVALID_CERTS|accept_invalid_certs|ignoreSSLIssues|allowUnauthorized|rejectUnauthorized\s*===\s*false/i;
const loopbackCondition = /\b(?:localhost|127\.0\.0\.1|::1|isLoopback)/i;
// libpq `sslmode` values that encrypt without verifying the certificate.
const unverifiedSslModes = new Set(['require', 'prefer', 'allow', 'no-verify']);

// `mode === 'require' || mode === 'prefer'`: only comparisons of one value with unverified libpq
// modes.
function isUnverifiedSslModeTest(condition: Expression) {
  const comparisons: Expression[] = [];
  (function collect(node: Expression): void {
    const expression = ts.skipOuterExpressions(node);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      collect(expression.left);
      collect(expression.right);
    } else comparisons.push(expression);
  })(condition);
  const comparedValues = new Set<string>();
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

// The override is reached only through an explicit opt-in: a self-signed flag tested without
// negation or alternatives, or a branch for the libpq modes that by definition skip verification.
function isExplicitOptIn(node: Node) {
  for (const { condition, branch } of enclosingBranches(node)) {
    if (branch !== 'true') continue;
    const text = condition.getText();
    if (selfSignedOptIn.test(text) && !/!|\|\|/.test(text)) return true;
    if (loopbackCondition.test(text) && !/!/.test(text)) return true;
    if (isUnverifiedSslModeTest(condition)) return true;
  }
  for (let current: Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isCaseClause(current) && selfSignedOptIn.test(current.expression.getText())) return true;
  }
  return false;
}

function reportTlsOverride(node: Node, context: SecurityRuleContext, message = tlsMessage) {
  if (isExplicitOptIn(node)) return;
  if (context.fileContext.underNonProductionGuard(node))
    return context.report(node, 'tls-verification-disabled', message, 'Disabled only outside production.');
  context.report(node, 'tls-verification-disabled', message);
}

// mysql2's 3.16+ v3 client opts out of hostname checks unless verifyIdentity is explicitly enabled.
// An omitted option needs a known driver version; an explicit false is visible in the source
// itself.
const resolveFrom = createRequire(import.meta.url);

function mysql2OmitsIdentityByDefault(sourceFile: SourceFile): boolean {
  try {
    const manifest = resolveFrom.resolve('mysql2/package.json', { paths: [path.dirname(sourceFile.fileName)] });
    const { name, version }: { name?: string; version?: string } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const release = /^3\.(\d+)\.\d+$/.exec(version ?? '');
    return name === 'mysql2' && !!release && Number(release[1]) >= 16;
  } catch (error) {
    // An uninstalled mysql2 is expected; an installed one whose manifest cannot be read leaves the
    // version unknown.
    if (error instanceof Error)
      noteUnreadable({
        error,
        location: 'the mysql2 version',
        consequence: 'skipped its hostname-check rule',
        absentCodes: ['MODULE_NOT_FOUND'],
      });
    return false;
  }
}

function inlineOptions(node: Node) {
  const object = ts.skipOuterExpressions(node);
  if (!ts.isObjectLiteralExpression(object)) return;
  const names = new Set<string>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    const name = propertyKeyName(property.name);
    if (name === undefined || name === '__proto__' || names.has(name)) return;
    names.add(name);
  }
  return object;
}

function explicitlyFalse(property: PropertyAssignment | ShorthandPropertyAssignment | undefined) {
  return (
    property &&
    ts.isPropertyAssignment(property) &&
    ts.skipOuterExpressions(property.initializer).kind === ts.SyntaxKind.FalseKeyword
  );
}

function checkMysqlTls(call: CallExpression, context: SecurityRuleContext) {
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

function checkTlsProperty(property: PropertyAssignment, context: SecurityRuleContext) {
  if (!verificationOptions.has(propertyKeyName(property.name) ?? '')) return;
  if (ts.skipOuterExpressions(property.initializer).kind === ts.SyntaxKind.FalseKeyword)
    reportTlsOverride(property, context);
}

function environmentVariableName(target: Node) {
  const expression = ts.skipOuterExpressions(target);
  const access = ts.isPropertyAccessExpression(expression)
    ? { object: expression.expression, key: expression.name.text }
    : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)
      ? { object: expression.expression, key: expression.argumentExpression.text }
      : undefined;
  return access && /^process\.env$/.test(access.object.getText()) ? access.key : undefined;
}

function isZero(node: Node) {
  const value = ts.skipOuterExpressions(node);
  return (
    (ts.isStringLiteralLike(value) && value.text === '0') || (ts.isNumericLiteral(value) && Number(value.text) === 0)
  );
}

function checkTlsAssignment(assignment: BinaryExpression, context: SecurityRuleContext) {
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
function isStaticInitializationVector(node: Expression, context: SecurityRuleContext) {
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

function weaknessOf(name: string, call: CallExpression, context: SecurityRuleContext): string | undefined {
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

function checkCipher(call: CallExpression, context: SecurityRuleContext) {
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

export { checkTlsProperty, checkTlsAssignment, checkMysqlTls, checkCipher };
