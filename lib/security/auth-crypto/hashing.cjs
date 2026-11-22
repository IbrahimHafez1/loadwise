'use strict';

// Password storage: fast unsalted hashes and bcrypt work factors that are cheap to brute-force.
const { syntax: ts } = require('../../performance/compiler.cjs');
const {
  fileMentions,
  libraryInfo,
  referencesOf,
  libraryFunction,
  resolveConstant,
  propertyKeyName,
  lastSegment,
  nameWords,
  enclosingFunction,
  functionName,
} = require('./shared.cjs');
const { isProjectSource, returnedExpressions } = require('../taint/summaries.cjs');

const weakAlgorithms = new Set(['md5', 'sha1', 'sha256', 'sha512']);
const passwordWords = new Set(['pass', 'password', 'passwd', 'pwd']);
// Names that mention a password but hold something else, such as a reset token or a verification code.
const notPasswordWords = new Set(['token', 'reset', 'code', 'otp', 'salt', 'length', 'field', 'url', 'link', 'email']);
const bcryptHashFunctions = new Set(['hash', 'hashSync']);
const bcryptCostFunctions = new Set(['hash', 'hashSync', 'genSalt', 'genSaltSync']);
const bcryptModules = ['bcrypt', 'bcryptjs'];
const minimumBcryptCost = 10;
// The HaveIBeenPwned range API takes the first five hex characters of a SHA-1 digest (k-anonymity).
const rangePrefixLength = 5;
const suggestedBcryptCost = 12;
const weakHashMessage =
  'A fast unsalted hash is used for a password; leaked hashes can be cracked at billions of guesses per second. Use `argon2`, `bcrypt` or `crypto.scrypt`.';

function isPasswordName(name) {
  if (!name) return false;
  const words = nameWords(name);
  const mentionsPassword = words.some((word) => passwordWords.has(word)) || /password|passwd/i.test(name);
  return mentionsPassword && !words.some((word) => notPasswordWords.has(word));
}

function containsPasswordName(expression) {
  let found = false;
  (function visit(node) {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && isPasswordName(node.text)) found = true;
    ts.forEachChild(node, visit);
  })(expression);
  return found;
}

// The statement context the finished digest lands in: its variable, property, assignment target or function.
function digestLandsInPasswordName(top) {
  let current = top;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isAwaitExpression(current.parent))
  )
    current = current.parent;
  const parent = current.parent;
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return isPasswordName(parent.name.text);
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    return isPasswordName(propertyKeyName(parent.name));
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return isPasswordName(lastSegment(parent.left));
  if (ts.isReturnStatement(parent)) {
    const fn = enclosingFunction(parent);
    return Boolean(fn) && isPasswordName(functionName(fn));
  }
  return false;
}

// A digest passed straight into bcrypt is a pre-hash, not the stored value.
function isBcryptInput(top, context) {
  const parent = top.parent;
  if (!parent || !ts.isCallExpression(parent) || !parent.arguments.includes(top)) return false;
  return bcryptHashFunctions.has(libraryFunction(parent, context, bcryptModules) ?? '');
}

// `createHash('sha1').update(a).update(b).digest('hex')`: the outermost call of the chain and every update argument.
function hashChain(hashCall) {
  const updates = [];
  let top = hashCall;
  for (;;) {
    const access = top.parent;
    const call = access?.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== top || !call || !ts.isCallExpression(call))
      break;
    if (call.expression !== access) break;
    if (access.name.text === 'update' && call.arguments[0]) updates.push(call.arguments[0]);
    top = call;
  }
  return { top, updates };
}

// A digest stored in a const and handed to `timingSafeEqual` is normalising a credential for comparison.
function isComparedInConstantTime(top, context) {
  const declaration = top.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const scope = enclosingFunction(declaration) ?? context.sourceFile;
  return referencesOf(declaration.name, scope, context.checker).some((reference) => {
    const call = reference.parent;
    return (
      ts.isCallExpression(call) &&
      call.arguments.includes(reference) &&
      call.expression.getText().endsWith('timingSafeEqual')
    );
  });
}

// `const sha1 = createHash('sha1')...` read only as `sha1.slice(0, 5)` for the range lookup is never stored.
function isBreachRangePrefix(top, context) {
  const declaration = top.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const scope = enclosingFunction(declaration) ?? context.sourceFile;
  return referencesOf(declaration.name, scope, context.checker).some((reference) => {
    const access = reference.parent;
    const call = access?.parent;
    if (!ts.isPropertyAccessExpression(access) || !ts.isCallExpression(call) || call.expression !== access)
      return false;
    const [start, end] = call.arguments.map((argument) => argument.getText());
    return /^(?:slice|substring)$/.test(access.name.text) && start === '0' && end === String(rangePrefixLength);
  });
}

function reportWeakHash(node, top, inputs, context) {
  if (isBcryptInput(top, context) || isComparedInConstantTime(top, context)) return;
  if (isBreachRangePrefix(top, context)) return;
  if (inputs.some(containsPasswordName) || digestLandsInPasswordName(top))
    context.report(node, 'weak-password-hash', weakHashMessage);
}

// The weak algorithm a non-crypto hashing package call computes: `md5(x)`, `CryptoJS.SHA1(x)`, `sha256(x)` from crypto-js.
function packageHashAlgorithm(info) {
  if (info.module === 'md5') return info.method ? undefined : 'md5';
  const subpath = /^crypto-js\/(md5|sha1|sha256|sha512)$/i.exec(info.module);
  if (subpath) return info.method ? undefined : subpath[1].toLowerCase();
  if (info.module !== 'crypto-js') return;
  const name = (info.method ?? info.exported).toLowerCase();
  return weakAlgorithms.has(name) ? name : undefined;
}

// A weak digest computed by `call`: `{ top, inputs }` for the finished chain and the hashed values.
function weakDigest(call, context) {
  const info = libraryInfo(call, context);
  if (!info?.module) return;
  if (info.module !== 'crypto')
    return packageHashAlgorithm(info) && call.arguments.length ? { top: call, inputs: [call.arguments[0]] } : undefined;
  if ((info.method ?? info.exported) !== 'createHash') return;
  const algorithm = call.arguments[0] && resolveConstant(call.arguments[0], context.checker);
  if (!algorithm || !ts.isStringLiteralLike(algorithm) || !weakAlgorithms.has(algorithm.text.toLowerCase())) return;
  const { top, updates } = hashChain(call);
  return { top, inputs: updates };
}

// The innermost call of a chain such as `createHash('md5').update(data).digest('hex')`.
function chainStart(expression) {
  let call = ts.skipOuterExpressions(expression);
  while (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
    const receiver = ts.skipOuterExpressions(call.expression.expression);
    if (!ts.isCallExpression(receiver)) break;
    call = receiver;
  }
  return call;
}

// `const hash = (data) => createHash('md5').update(data).digest('hex')`: the parameter indexes a project helper
// returns a weak digest of. A helper whose own input is password-named is reported inside it instead.
function weakDigestParameters(fn, context) {
  const indexes = new Set();
  for (const expression of returnedExpressions(fn) ?? []) {
    const start = chainStart(expression);
    const digest = ts.isCallExpression(start) ? weakDigest(start, context) : undefined;
    if (!digest || digest.top !== ts.skipOuterExpressions(expression) || digest.inputs.some(containsPasswordName))
      continue;
    for (const input of digest.inputs) {
      const value = ts.skipOuterExpressions(input);
      const index = fn.parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && ts.isIdentifier(value) && parameter.name.text === value.text,
      );
      if (index >= 0) indexes.add(index);
    }
  }
  return [...indexes];
}

// One call deep: `security.hash(req.body.password)` where the project helper computes a fast unsalted digest.
function checkLocalWeakHash(call, context) {
  if (!call.arguments.some(containsPasswordName) && !digestLandsInPasswordName(call)) return;
  const fn = context.checker.getResolvedSignature(call)?.declaration;
  if (!fn || !ts.isFunctionLike(fn) || !fn.body || !isProjectSource(fn.getSourceFile())) return;
  if (!fileMentions(fn.getSourceFile(), ['crypto', 'md5'])) return;
  const inputs = weakDigestParameters(fn, context)
    .map((index) => call.arguments[index])
    .filter(Boolean);
  if (!inputs.length) return;
  if (isBcryptInput(call, context) || isComparedInConstantTime(call, context) || isBreachRangePrefix(call, context))
    return;
  if (inputs.some(containsPasswordName) || digestLandsInPasswordName(call))
    context.report(call, 'weak-password-hash', weakHashMessage);
}

function checkWeakPasswordHash(call, context) {
  const digest = fileMentions(context.sourceFile, ['crypto', 'md5']) ? weakDigest(call, context) : undefined;
  if (digest) return reportWeakHash(call, digest.top, digest.inputs, context);
  checkLocalWeakHash(call, context);
}

// A numeric literal or a const that resolves to one; a conditional on the test environment yields its other branch.
function literalCost(expression, checker) {
  const node = resolveConstant(expression, checker);
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (!ts.isConditionalExpression(node)) return;
  const condition = node.condition.getText();
  if (/===?\s*['"]test['"]/.test(condition)) return literalCost(node.whenFalse, checker);
  if (/!==?\s*['"]test['"]/.test(condition)) return literalCost(node.whenTrue, checker);
}

function underTestEnvironmentBranch(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (!ts.isConditionalExpression(parent) && !ts.isIfStatement(parent)) continue;
    const condition = ts.isIfStatement(parent) ? parent.expression : parent.condition;
    const taken = ts.isIfStatement(parent) ? parent.thenStatement : parent.whenTrue;
    if (child === taken && /NODE_ENV\s*===?\s*['"]test['"]/.test(condition.getText())) return true;
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

function checkBcryptCost(call, context) {
  if (!fileMentions(context.sourceFile, bcryptModules)) return;
  const name = libraryFunction(call, context, bcryptModules);
  if (!name || !bcryptCostFunctions.has(name)) return;
  const costIndex = name === 'hash' || name === 'hashSync' ? 1 : 0;
  const argument = call.arguments[costIndex];
  if (!argument) return;
  const cost = literalCost(argument, context.checker);
  if (cost === undefined || cost >= minimumBcryptCost || underTestEnvironmentBranch(call)) return;
  context.report(
    argument,
    'bcrypt-low-cost',
    `bcrypt cost ${cost} is below the minimum of ${minimumBcryptCost} and is cheap to brute-force. Use ${minimumBcryptCost} or higher (${suggestedBcryptCost} is a common choice) and measure the hashing time on your hardware.`,
  );
}

module.exports = { checkWeakPasswordHash, checkBcryptCost };
