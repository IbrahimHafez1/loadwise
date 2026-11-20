'use strict';

const { syntax: ts } = require('./compiler.cjs');

const BCRYPT_PACKAGES = ['bcrypt', 'bcryptjs', '@types/bcrypt', '@types/bcryptjs'];
const asyncReplacements = new Map([
  ['hashSync', 'await bcrypt.hash(password, rounds)'],
  ['compareSync', 'await bcrypt.compare(password, hash)'],
  ['genSaltSync', 'await bcrypt.genSalt(rounds)'],
]);
const requestParameterNames = new Set(['req', 'request']);

// node-fs.cjs keeps its async-owner walk private; this is the same idea widened to request handlers.
function isAsyncFunction(node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function isRequestHandler(node) {
  const [first] = node.parameters;
  return !!first && ts.isIdentifier(first.name) && requestParameterNames.has(first.name.text);
}

function runsOnRequestPath(call) {
  for (let parent = call.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) && (isAsyncFunction(parent) || isRequestHandler(parent))) return true;
  }
  return false;
}

function isBcryptCall(call, checker) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration) return false;
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const start = filename.lastIndexOf('/node_modules/');
  if (start < 0) return false;
  const withinModules = filename.slice(start + '/node_modules/'.length);
  return BCRYPT_PACKAGES.some((name) => withinModules.startsWith(name + '/'));
}

function calledName(callee) {
  if (ts.isPropertyAccessExpression(callee)) return callee.name;
  if (ts.isIdentifier(callee)) return callee;
}

function receiverLabel(callee) {
  if (!ts.isPropertyAccessExpression(callee)) return 'bcrypt';
  const receiver = ts.skipOuterExpressions(callee.expression);
  return ts.isIdentifier(receiver) ? receiver.text : 'bcrypt';
}

function checkPasswordHashing(node, context) {
  const name = calledName(node.expression);
  const replacement = name && asyncReplacements.get(name.text);
  if (!replacement || !runsOnRequestPath(node) || !isBcryptCall(node, context.checker)) return;
  const label = receiverLabel(node.expression);
  context.report(
    name,
    'password-hash-sync-in-async',
    `\`${label}.${name.text}\` blocks the event loop for the whole hash (about 50–100 ms at cost 10), stalling every other request. Use \`${replacement.replace('bcrypt.', `${label}.`)}\`.`,
  );
}

module.exports = { checkPasswordHashing };
