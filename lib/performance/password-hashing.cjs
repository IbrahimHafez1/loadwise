'use strict';

const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');
const { isAsyncFunction } = require('./function-kinds.cjs');
const { isTestSource } = require('./review-context.cjs');

const BCRYPT_PACKAGES = ['bcrypt', 'bcryptjs', '@types/bcrypt', '@types/bcryptjs'];
const BCRYPT_MODULES = new Set(['bcrypt', 'bcryptjs']);
const CRYPTO_MODULES = new Set(['crypto', 'node:crypto']);
const asyncReplacements = new Map([
  ['hashSync', 'await bcrypt.hash(password, rounds)'],
  ['compareSync', 'await bcrypt.compare(password, hash)'],
  ['genSaltSync', 'await bcrypt.genSalt(rounds)'],
]);
// node-fs.cjs reports these when they sit directly in async code; this module adds the one-hop helper case.
const cryptoReplacements = new Map([
  ['scryptSync', 'await promisify(crypto.scrypt)(password, salt, keyLength)'],
  ['pbkdf2Sync', 'await promisify(crypto.pbkdf2)(password, salt, iterations, keyLength, digest)'],
]);
const requestParameterNames = new Set(['req', 'request']);
const PASSWORD_HASH_KIND = 'password-hash';
// A hash reached through this many project functions below the callee is reported by default; deeper is contextual.
const MAX_DEFAULT_HELPER_HOPS = 1;

// node-fs.cjs keeps its async-owner walk private; this is the same idea widened to request handlers.
function isRequestHandler(node) {
  const [first] = node.parameters;
  return !!first && ts.isIdentifier(first.name) && requestParameterNames.has(first.name.text);
}

function requestPathOwner(call) {
  for (let parent = call.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) && (isAsyncFunction(parent) || isRequestHandler(parent))) return parent;
  }
}

function runsOnRequestPath(call) {
  return !!requestPathOwner(call);
}

// The module an import binds the call's root identifier to, for projects whose package types are not installed.
function importedModule(callee, checker) {
  const root = ts.isPropertyAccessExpression(callee) ? ts.skipOuterExpressions(callee.expression) : callee;
  if (!ts.isIdentifier(root)) return;
  const declaration = checker.getSymbolAtLocation(root)?.declarations?.[0];
  const statement = declaration && ts.findAncestor(declaration, ts.isImportDeclaration);
  if (!statement || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) return;
  return statement.moduleSpecifier.text;
}

function isBcryptCall(call, checker) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration) return BCRYPT_MODULES.has(importedModule(call.expression, checker));
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

function receiverLabel(callee, fallback = 'bcrypt') {
  if (!ts.isPropertyAccessExpression(callee)) return fallback;
  const receiver = ts.skipOuterExpressions(callee.expression);
  return ts.isIdentifier(receiver) ? receiver.text : fallback;
}

function declarationName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name))
    return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent))
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
}

// The named sync function or method whose own body makes the call, so its callers decide where it runs.
function syncHelper(call) {
  const helper = ts.findAncestor(call.parent, ts.isFunctionLike);
  if (!helper || isAsyncFunction(helper) || helper.asteriskToken || isRequestHandler(helper)) return;
  return declarationName(helper) ? helper : undefined;
}

function projectSources(program) {
  const sources = program?.getToolingSourceFiles?.() ?? program?.getSourceFiles?.() ?? [];
  return sources.filter(
    (source) =>
      !source.isDeclarationFile &&
      !/[\\/]node_modules[\\/]/.test(source.fileName) &&
      !isTestSource(source.fileName.replaceAll('\\', '/')),
  );
}

function isSameDeclaration(candidate, helper) {
  return (
    !!candidate &&
    candidate.pos === helper.pos &&
    candidate.getSourceFile().fileName === helper.getSourceFile().fileName
  );
}

// The first project call to `helper` that itself runs on a request path: one hop up the call graph.
function findRequestPathCaller(helper, context) {
  const name = declarationName(helper);
  for (const source of projectSources(context.program)) {
    if (!source.text.includes(name)) continue;
    let caller;
    (function visit(node) {
      if (caller) return;
      if (
        ts.isCallExpression(node) &&
        calledName(node.expression)?.text === name &&
        runsOnRequestPath(node) &&
        isSameDeclaration(context.checker.getResolvedSignature(node)?.declaration, helper)
      )
        caller = node;
      else ts.forEachChild(node, visit);
    })(source);
    if (caller) return caller;
  }
}

const requestPathCallers = new WeakMap();

function requestPathCaller(helper, context) {
  if (!requestPathCallers.has(helper)) requestPathCallers.set(helper, findRequestPathCaller(helper, context));
  return requestPathCallers.get(helper);
}

function callerDescription(caller) {
  const ownerName = declarationName(requestPathOwner(caller));
  const sourceFile = caller.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(caller.getStart(sourceFile));
  const location = `${path.basename(sourceFile.fileName)}:${line + 1}`;
  return ownerName ? `\`${ownerName}\` (${location})` : location;
}

function reportThroughHelper(node, name, ruleId, { cost, replacement }, context) {
  const helper = syncHelper(node);
  const caller = helper && requestPathCaller(helper, context);
  if (!caller) return;
  const helperName = declarationName(helper);
  context.report(
    name,
    ruleId,
    `\`${name.text}\` runs inside the sync helper \`${helperName}\`, which ${callerDescription(caller)} calls on a request path, so it blocks the event loop for the whole hash (${cost}), stalling every other request. Make \`${helperName}\` async with \`${replacement}\` and await it at each caller.`,
  );
}

function checkBcryptCall(node, name, context) {
  if (!isBcryptCall(node, context.checker)) return;
  const label = receiverLabel(node.expression);
  const replacement = asyncReplacements.get(name.text).replace('bcrypt.', `${label}.`);
  if (!runsOnRequestPath(node)) {
    const hash = { cost: 'about 50–100 ms at cost 10', replacement };
    reportThroughHelper(node, name, 'password-hash-sync-in-async', hash, context);
    return;
  }
  context.report(
    name,
    'password-hash-sync-in-async',
    `\`${label}.${name.text}\` blocks the event loop for the whole hash (about 50–100 ms at cost 10), stalling every other request. Use \`${replacement}\`.`,
  );
}

function checkCryptoHashCall(node, name, context) {
  if (runsOnRequestPath(node) || !CRYPTO_MODULES.has(importedModule(node.expression, context.checker))) return;
  const label = receiverLabel(node.expression, 'crypto');
  const replacement = cryptoReplacements.get(name.text).replace('crypto.', `${label}.`);
  const hash = { cost: 'often tens of milliseconds', replacement };
  reportThroughHelper(node, name, 'node-sync-crypto-in-async', hash, context);
}

// A request-path call to a project function that reaches a sync bcrypt call through further helpers. A direct
// call inside the callee is reported at the bcrypt call itself, by reportThroughHelper.
function checkHashReachedThroughCallee(node, name, context) {
  if (!context.program || !runsOnRequestPath(node)) return;
  // Lazy: function-summaries.cjs requires this module for `asyncReplacements`.
  const { functionSummaries } = require('../shared/function-summaries.cjs');
  const summary = functionSummaries(context.program).summaryOfCall(node);
  const hash = summary?.blocking.find((effect) => effect.kind === PASSWORD_HASH_KIND && effect.via.length > 0);
  if (!hash) return;
  const route = [name.text, ...hash.via].map((step) => `\`${step}\``).join(' -> ');
  const reason =
    hash.via.length > MAX_DEFAULT_HELPER_HOPS || !summary.complete
      ? 'The sync hash sits several helpers below this request-path call, or the call chain was cut short, so confirm every helper runs on the request path before making them async.'
      : undefined;
  context.report(
    name,
    'password-hash-sync-in-async',
    `\`${name.text}()\` runs on a request path and reaches \`${hash.label}\` through ${route}, which blocks the event loop for the whole hash (about 50–100 ms at cost 10), stalling every other request. Make the helpers async with \`${asyncReplacements.get(hash.label)}\` and await each of them.`,
    reason,
  );
}

function checkPasswordHashing(node, context) {
  const name = calledName(node.expression);
  if (!name) return;
  if (asyncReplacements.has(name.text)) checkBcryptCall(node, name, context);
  else if (cryptoReplacements.has(name.text)) checkCryptoHashCall(node, name, context);
  else checkHashReachedThroughCallee(node, name, context);
}

module.exports = { asyncReplacements, checkPasswordHashing, isAsyncFunction, isBcryptCall, isRequestHandler };
