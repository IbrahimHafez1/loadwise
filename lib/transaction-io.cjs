'use strict';

const { syntax: ts } = require('./compiler.cjs');

const TRANSACTION_PACKAGES = ['typeorm/', 'sequelize/', 'sequelize-typescript/', 'knex/', 'drizzle-orm/'];
const AXIOS_PACKAGES = ['axios/'];
const MAILER_PACKAGES = ['nodemailer/', '@types/nodemailer/'];
const AWS_PACKAGES = ['@aws-sdk/', '@smithy/', 'aws-sdk/'];
const SUPABASE_STORAGE_PACKAGES = ['@supabase/storage-js/'];
const SUPABASE_STORAGE_METHODS = new Set([
  'upload',
  'uploadToSignedUrl',
  'update',
  'download',
  'remove',
  'copy',
  'move',
]);
const FS_WRITE_METHODS = new Set(['writeFile', 'appendFile', 'copyFile', 'rename', 'unlink', 'rm', 'mkdir']);
const TEST_FILE = /(?:\/(?:__tests__|e2e)\/|\.(?:test|spec|e2e|e2e-spec|itest|e2e-test)\.[cm]?[jt]sx?$)/;
// A project method that calls a project method that does the IO is the realistic service -> provider shape.
const PROJECT_RESOLUTION_DEPTH = 2;

function modulePathOf(declaration) {
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  return start < 0 ? undefined : filename.slice(start + marker.length);
}

function declarationOf(call, checker) {
  return checker.getResolvedSignature(call)?.declaration;
}

function isInPackages(declaration, packages) {
  const modulePath = declaration && modulePathOf(declaration);
  return !!modulePath && packages.some((name) => modulePath.startsWith(name));
}

function calledName(callee) {
  if (ts.isPropertyAccessExpression(callee)) return callee.name;
  if (ts.isIdentifier(callee)) return callee;
}

function isGlobalFetch(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  const onGlobalObject =
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'globalThis';
  const fetchName = ts.isIdentifier(callee) ? callee : onGlobalObject ? callee.name : undefined;
  if (fetchName?.text !== 'fetch') return false;
  const declarations = checker.getSymbolAtLocation(fetchName)?.declarations;
  return !declarations?.length || declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

const FS_PROMISES_MODULES = new Set(['promises', 'fs/promises', 'node:fs/promises']);

function isFsPromisesDeclaration(declaration) {
  if (!declaration || !modulePathOf(declaration)?.startsWith('@types/node/')) return false;
  for (let parent = declaration.parent; parent; parent = parent.parent) {
    if (ts.isModuleDeclaration(parent) && FS_PROMISES_MODULES.has(parent.name.text)) return true;
  }
  return false;
}

// Names the network or file IO a call performs, or returns undefined for anything else.
function externalLabel(call, checker) {
  if (isGlobalFetch(call, checker)) return 'fetch';
  const name = calledName(ts.skipOuterExpressions(call.expression))?.text;
  const declaration = declarationOf(call, checker);
  if (!declaration || !name) return;
  if (isInPackages(declaration, AXIOS_PACKAGES)) return 'axios';
  if (name === 'sendMail' && isInPackages(declaration, MAILER_PACKAGES)) return 'nodemailer sendMail';
  if (name === 'send' && isInPackages(declaration, AWS_PACKAGES)) return 'AWS SDK send';
  if (SUPABASE_STORAGE_METHODS.has(name) && isInPackages(declaration, SUPABASE_STORAGE_PACKAGES)) {
    return `Supabase storage ${name}`;
  }
  if (FS_WRITE_METHODS.has(name) && isFsPromisesDeclaration(declaration)) return `fs.promises.${name}`;
}

function isAwaited(call) {
  let current = call;
  while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))) {
    current = current.parent;
  }
  return !!current.parent && ts.isAwaitExpression(current.parent);
}

function isReturned(call) {
  const parent = call.parent;
  return ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === call);
}

function functionBodyOf(declaration) {
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) {
    const initializer = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
    return initializer && ts.isFunctionLike(initializer) ? initializer.body : undefined;
  }
  return ts.isFunctionLike(declaration) ? declaration.body : undefined;
}

function isProjectDeclaration(declaration) {
  return !declaration.getSourceFile().isDeclarationFile && modulePathOf(declaration) === undefined;
}

function nameOfDeclaration(declaration) {
  return declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : 'function';
}

// Finds IO that a function body awaits (or returns) directly, descending through project calls up to `depth` hops.
function findIo(body, checker, depth, visiting) {
  let found;
  (function visit(node) {
    if (found || (node !== body && ts.isFunctionLike(node))) return;
    if (ts.isCallExpression(node) && (isAwaited(node) || isReturned(node)))
      found = ioOf(node, checker, depth, visiting);
    if (!found) ts.forEachChild(node, visit);
  })(body);
  return found;
}

function ioOf(call, checker, depth, visiting) {
  const label = externalLabel(call, checker);
  if (label) return { label, via: [] };
  if (depth === 0) return;
  const declaration = declarationOf(call, checker);
  const body = declaration && isProjectDeclaration(declaration) ? functionBodyOf(declaration) : undefined;
  if (!body || visiting.has(declaration)) return;
  visiting.add(declaration);
  const inner = findIo(body, checker, depth - 1, visiting);
  visiting.delete(declaration);
  return inner && { label: inner.label, via: [nameOfDeclaration(declaration), ...inner.via] };
}

function typeFromPackages(type, packages) {
  const symbols = [type.getSymbol(), type.aliasSymbol].filter(Boolean);
  return symbols.some((symbol) => symbol.declarations?.some((declaration) => isInPackages(declaration, packages)));
}

function isTransactionCall(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text === '$transaction') return true;
  if (callee.name.text !== 'transaction') return false;
  return typeFromPackages(checker.getTypeAtLocation(callee.expression), TRANSACTION_PACKAGES);
}

// The innermost transaction callback around `node`, with the name of its client parameter.
function enclosingTransaction(node, checker) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isFunctionLike(parent) || !parent.parent || !ts.isCallExpression(parent.parent)) continue;
    if (!parent.parent.arguments.includes(parent) || !isTransactionCall(parent.parent, checker)) continue;
    const [client] = parent.parameters;
    return { client: client && ts.isIdentifier(client.name) ? client.name.text : undefined };
  }
}

function mentions(node, name) {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return !!ts.forEachChild(node, (child) => mentions(child, name) || undefined);
}

// A call handed the transaction client is DB work on that transaction, not an external call.
function receivesClient(call, clientName) {
  return !!clientName && call.arguments.some((argument) => mentions(argument, clientName));
}

function describeTarget(io, call) {
  if (io.via.length === 0) return `\`${io.label}\``;
  const written = ts.skipOuterExpressions(call.expression).getText();
  return `\`${written}()\`, which reaches ${io.label} through ${io.via.map((name) => `\`${name}()\``).join(' -> ')},`;
}

function check(node, context) {
  if (!isAwaited(node) || TEST_FILE.test(node.getSourceFile().fileName.replaceAll('\\', '/'))) return;
  const transaction = enclosingTransaction(node, context.checker);
  if (!transaction || receivesClient(node, transaction.client)) return;
  const io = ioOf(node, context.checker, PROJECT_RESOLUTION_DEPTH, new Set());
  if (!io) return;
  const reportNode = calledName(ts.skipOuterExpressions(node.expression)) ?? node;
  context.report(
    reportNode,
    'external-call-in-transaction',
    `Awaiting ${describeTarget(io, node)} inside a database transaction callback keeps the transaction's pooled connection and its row or advisory locks held until the external call returns. Slow upstreams exhaust the pool and serialize writers. Do the call before opening the transaction, or after commit (write an outbox row for side effects that must follow the data). Caveat: a side effect cannot roll back with the transaction, so a failure after it needs compensation.`,
  );
}

module.exports = { check };
