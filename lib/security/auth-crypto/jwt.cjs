'use strict';

// jsonwebtoken, @nestjs/jwt and jwt-decode misuse: unverified payloads, unpinned algorithms, `none`, no expiry.
const { syntax: ts } = require('../../performance/compiler.cjs');
const {
  fileMentions,
  libraryInfo,
  libraryFunction,
  resolveConstant,
  propertyKeyName,
  findProperty,
  hasSpread,
  enclosingFunction,
  functionName,
  isFunctionExpressionLike,
  referencesOf,
} = require('./shared.cjs');

const jwtLibraries = ['jsonwebtoken', '@nestjs/jwt', 'jwt-decode'];
const verifyNames = new Set(['verify', 'verifyAsync', 'jwtVerify']);
const authFunctionName = /auth|guard|authenticate|authorize/i;
const authMethodNames = new Set(['canActivate', 'validate']);
const requestUserTarget = /^(?:req|request|ctx\.state|context\.state)\.user$/;
const databaseMethodNames = new Set([
  'find',
  'findOne',
  'findFirst',
  'findUnique',
  'findMany',
  'findOneBy',
  'findBy',
  'findById',
  'findByPk',
  'findOneOrFail',
  'where',
  'andWhere',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'exists',
]);
// Claims that are read for housekeeping, not for an access decision.
const harmlessClaims = new Set(['exp', 'iat', 'nbf', 'header']);
const noneAlgorithm = 'none';
const asymmetricKeyName = /public|pem|cert|jwk/i;
const messages = {
  decode:
    '`decode` does not check the signature, so anyone can forge this payload. Use `verify` with the expected algorithms before trusting any claim.',
  verify:
    "This `jwt.verify` call does not pin `algorithms`, so the token header chooses how it is checked. Pass the algorithms you sign with, for example `{ algorithms: ['RS256'] }`.",
  none: 'The `none` algorithm accepts unsigned tokens. Remove it and list only the algorithms you sign with.',
  expiry:
    'This token is signed without an expiry, so a leaked token works forever. Set `expiresIn` (or an `exp` claim) and rotate with refresh tokens.',
};

function callName(call) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

function isDecodeCall(call, context) {
  const info = libraryInfo(call, context);
  if (!info?.module) return false;
  if (info.module === 'jwt-decode') return !info.method;
  if (info.module !== 'jsonwebtoken' && info.module !== '@nestjs/jwt') return false;
  return (info.method ?? info.exported) === 'decode';
}

function isVerifiedInside(scope, tokenText) {
  let verified = false;
  (function visit(node) {
    if (verified) return;
    if (
      ts.isCallExpression(node) &&
      verifyNames.has(callName(node) ?? '') &&
      node.arguments[0]?.getText() === tokenText
    )
      verified = true;
    ts.forEachChild(node, visit);
  })(scope);
  return verified;
}

function isExpressMiddlewareShape(fn) {
  const names = fn.parameters.map((parameter) => parameter.name.getText());
  return names.length === 3 && /^(?:req|request)$/.test(names[0]) && names[1].startsWith('res') && names[2] === 'next';
}

function isAuthFunction(fn) {
  const name = functionName(fn);
  if (name && (authMethodNames.has(name) || authFunctionName.test(name))) return true;
  return isExpressMiddlewareShape(fn);
}

function insideAuthFunction(node) {
  for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) if (isAuthFunction(fn)) return true;
  return false;
}

// Where the decoded value goes: a variable it is bound to, a property it is assigned to, or a claim read at once.
function valueSite(call) {
  let current = call;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isAwaitExpression(current.parent))
  )
    current = current.parent;
  const parent = current.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === current)
    return ts.isIdentifier(parent.name) ? { variable: parent.name } : {};
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.right === current &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return { assignedTo: parent.left.getText().replace(/\s+/g, '') };
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === current)
    return { claim: parent.name.text };
  return {};
}

function isInsideFunctionBetween(node, boundary) {
  for (let current = node.parent; current && current !== boundary; current = current.parent)
    if (ts.isFunctionLike(current)) return true;
  return false;
}

function isWithin(node, container) {
  return container.pos <= node.pos && node.end <= container.end;
}

function isDatabaseFilterUse(reference) {
  const call = ts.findAncestor(
    reference,
    (node) => ts.isCallExpression(node) && databaseMethodNames.has(callName(node) ?? ''),
  );
  if (!call || !call.arguments.some((argument) => isWithin(reference, argument))) return false;
  return !isInsideFunctionBetween(reference, call);
}

function isAssignedToRequestUser(reference) {
  const assignment = ts.findAncestor(reference, ts.isBinaryExpression);
  return (
    assignment?.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    requestUserTarget.test(assignment.left.getText().replace(/\s+/g, '')) &&
    isWithin(reference, assignment.right)
  );
}

// `if (decoded && decoded.exp)`: the value is tested, not trusted.
function isTruthinessCheck(reference) {
  const parent = reference.parent;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent))
    return parent.expression === reference || parent.condition === reference;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === reference &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)
  );
}

// 'harmless' when only housekeeping claims are read, 'trusted' when the value reaches an access decision.
function classifyDecode(call, scope, context) {
  const site = valueSite(call);
  if (site.claim) return harmlessClaims.has(site.claim) ? 'harmless' : 'other';
  if (site.assignedTo) return requestUserTarget.test(site.assignedTo) ? 'trusted' : 'other';
  if (!site.variable) return 'other';
  let wholeValueUsed = false;
  let trusted = false;
  let truthinessChecked = false;
  let claimRead = false;
  for (const reference of referencesOf(site.variable, scope, context.checker)) {
    const parent = reference.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === reference &&
      harmlessClaims.has(parent.name.text)
    ) {
      claimRead = true;
      continue;
    }
    if (isTruthinessCheck(reference)) {
      truthinessChecked = true;
      continue;
    }
    wholeValueUsed = true;
    if (isAssignedToRequestUser(reference) || isDatabaseFilterUse(reference)) trusted = true;
  }
  if (trusted) return 'trusted';
  // `if (decoded)` on its own is the access decision; next to an `exp` read it is a guard around that read.
  return wholeValueUsed || (truthinessChecked && !claimRead) ? 'other' : 'harmless';
}

function checkJwtDecode(call, context) {
  if (!call.arguments.length || !fileMentions(context.sourceFile, jwtLibraries)) return;
  if (/\.[jt]sx$/.test(context.sourceFile.fileName)) return;
  if (!isDecodeCall(call, context)) return;
  const scope = enclosingFunction(call) ?? context.sourceFile;
  if (isVerifiedInside(scope, call.arguments[0].getText())) return;
  const usage = classifyDecode(call, scope, context);
  if (usage === 'harmless') return;
  if (usage === 'trusted' || insideAuthFunction(call))
    return context.report(call, 'jwt-decode-for-auth', messages.decode);
  context.report(
    call,
    'jwt-decode-for-auth',
    messages.decode,
    'The decoded claims are not clearly used for an access decision here.',
  );
}

function optionsArgument(call, optionsIndex, context) {
  const argument = call.arguments[optionsIndex];
  if (!argument || isFunctionExpressionLike(argument)) return {};
  const resolved = resolveConstant(argument, context.checker);
  if (!ts.isObjectLiteralExpression(resolved) || hasSpread(resolved)) return { opaque: true };
  return { literal: resolved };
}

function keyLooksAsymmetric(keyNode, context) {
  const key = ts.skipOuterExpressions(keyNode);
  if (isFunctionExpressionLike(key)) return true;
  if (ts.isCallExpression(key)) return key.expression.getText().endsWith('readFileSync');
  if (ts.isIdentifier(key)) {
    const declaration = context.checker.getSymbolAtLocation(key)?.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration)) return true;
    if (declaration && ts.isParameter(declaration) && declaration.type && ts.isFunctionTypeNode(declaration.type))
      return true;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isFunctionExpressionLike(declaration.initializer)
    )
      return true;
  }
  return asymmetricKeyName.test(key.getText());
}

function checkJwtVerify(call, context) {
  if (call.arguments.length < 2 || !fileMentions(context.sourceFile, ['jsonwebtoken'])) return;
  if (libraryFunction(call, context, ['jsonwebtoken']) !== 'verify') return;
  const options = optionsArgument(call, 2, context);
  if (options.opaque || (options.literal && findProperty(options.literal, 'algorithms'))) return;
  if (keyLooksAsymmetric(call.arguments[1], context))
    return context.report(call, 'jwt-verify-without-algorithms', messages.verify);
  context.report(
    call,
    'jwt-verify-without-algorithms',
    messages.verify,
    'The key is a shared secret, so an unpinned algorithm is less exploitable here.',
  );
}

function isNoneLiteral(node) {
  return ts.isStringLiteralLike(node) && node.text.toLowerCase() === noneAlgorithm;
}

function checkJwtNone(property, context) {
  const name = propertyKeyName(property.name);
  const value = ts.skipOuterExpressions(property.initializer);
  if (name === 'algorithms' && ts.isArrayLiteralExpression(value)) {
    const none = value.elements.find(isNoneLiteral);
    if (none) context.report(none, 'jwt-none-algorithm', messages.none);
    return;
  }
  // `algorithm: 'none'` is only a signing option when the object is handed to a sign call.
  if (name !== 'algorithm' || !isNoneLiteral(value)) return;
  const call = ts.findAncestor(property, ts.isCallExpression);
  if (call && /^sign(?:Async|Sync)?$/.test(callName(call) ?? '') && call.arguments.includes(property.parent))
    context.report(value, 'jwt-none-algorithm', messages.none);
}

function checkJwtSign(call, context) {
  if (call.arguments.length < 2 || !fileMentions(context.sourceFile, ['jsonwebtoken'])) return;
  if (libraryFunction(call, context, ['jsonwebtoken']) !== 'sign') return;
  const options = optionsArgument(call, 2, context);
  if (options.opaque || (options.literal && findProperty(options.literal, 'expiresIn'))) return;
  const payload = resolveConstant(call.arguments[0], context.checker);
  if (ts.isStringLiteralLike(payload) || ts.isTemplateExpression(payload)) return;
  if (!ts.isObjectLiteralExpression(payload) || hasSpread(payload))
    return context.report(
      call,
      'jwt-sign-without-expiry',
      messages.expiry,
      'The token payload is not an object literal, so an `exp` claim may be set elsewhere.',
    );
  if (!findProperty(payload, 'exp')) context.report(call, 'jwt-sign-without-expiry', messages.expiry);
}

module.exports = { checkJwtDecode, checkJwtVerify, checkJwtNone, checkJwtSign };
