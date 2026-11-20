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
const PASSWORD_HASH_PACKAGES = [
  'bcrypt/',
  '@types/bcrypt/',
  'bcryptjs/',
  '@types/bcryptjs/',
  'argon2/',
  '@node-rs/bcrypt/',
  '@node-rs/argon2/',
];
const PASSWORD_HASH_METHODS = new Set(['hash', 'compare', 'verify']);
const TYPEORM_PACKAGES = ['typeorm/'];
const TYPEORM_WRITE_METHODS = new Set([
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'remove',
  'softDelete',
  'softRemove',
  'restore',
  'recover',
  'increment',
  'decrement',
  'clear',
]);
const WRITE_SQL = /^\s*(?:insert|update|delete|merge)\b/i;
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

// Password hashing deliberately burns tens to hundreds of milliseconds of CPU per call.
function passwordHashLabel(call, checker) {
  const name = calledName(ts.skipOuterExpressions(call.expression))?.text;
  if (!name || !PASSWORD_HASH_METHODS.has(name)) return;
  const declaration = declarationOf(call, checker);
  if (!isInPackages(declaration, PASSWORD_HASH_PACKAGES)) return;
  const [scopeOrName, scopedName] = modulePathOf(declaration).replace(/^@types\//, '').split('/');
  return `${scopeOrName.startsWith('@') ? `${scopeOrName}/${scopedName}` : scopeOrName} ${name}`;
}

function slowWork(call, checker) {
  const io = externalLabel(call, checker);
  if (io) return { label: io, kind: 'io' };
  const hash = passwordHashLabel(call, checker);
  if (hash) return { label: hash, kind: 'cpu' };
}

// `this.repository`, an imported repository or a module-level data source: never the transaction's own manager.
function isSharedReceiver(expression, checker) {
  let root = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root) || ts.isElementAccessExpression(root)) {
    root = ts.skipOuterExpressions(root.expression);
  }
  if (root.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (!ts.isIdentifier(root)) return false;
  const [declaration] = checker.getSymbolAtLocation(root)?.declarations ?? [];
  if (!declaration) return false;
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration))
    return true;
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent) &&
    ts.isSourceFile(declaration.parent.parent.parent)
  );
}

// A TypeORM write through a repository or manager that is not bound to the surrounding transaction.
function escapedWrite(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !isSharedReceiver(callee.expression, checker)) return;
  const name = callee.name.text;
  if (name === 'query') {
    const [sql] = call.arguments;
    if (!sql || !ts.isStringLiteralLike(sql) || !WRITE_SQL.test(sql.text)) return;
  } else if (!TYPEORM_WRITE_METHODS.has(name)) return;
  if (!isInPackages(declarationOf(call, checker), TYPEORM_PACKAGES)) return;
  return { label: `${callee.getText()}()`, kind: 'escape' };
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

// Finds work `classify` recognizes that a function body awaits (or returns) directly, descending through
// project calls up to `depth` hops.
function findWork(body, classify, checker, depth, visiting) {
  let found;
  (function visit(node) {
    if (found || (node !== body && ts.isFunctionLike(node))) return;
    if (ts.isCallExpression(node) && (isAwaited(node) || isReturned(node)))
      found = workOf(node, classify, checker, depth, visiting);
    if (!found) ts.forEachChild(node, visit);
  })(body);
  return found;
}

function workOf(call, classify, checker, depth, visiting) {
  const work = classify(call, checker);
  if (work) return { ...work, via: [] };
  if (depth === 0) return;
  const declaration = declarationOf(call, checker);
  const body = declaration && isProjectDeclaration(declaration) ? functionBodyOf(declaration) : undefined;
  if (!body || visiting.has(declaration)) return;
  visiting.add(declaration);
  const inner = findWork(body, classify, checker, depth - 1, visiting);
  visiting.delete(declaration);
  return inner && { ...inner, via: [nameOfDeclaration(declaration), ...inner.via] };
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

function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
}

const queryRunnerSpans = new WeakMap();

function queryRunnerCall(node, checker, method) {
  if (!ts.isCallExpression(node)) return;
  const callee = ts.skipOuterExpressions(node.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== method) return;
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (!ts.isIdentifier(receiver) || !isInPackages(declarationOf(node, checker), TYPEORM_PACKAGES)) return;
  return receiver.text;
}

// Source ranges between `runner.startTransaction()` and `runner.commitTransaction()` in one function body.
function transactionSpans(owner, checker) {
  if (queryRunnerSpans.has(owner)) return queryRunnerSpans.get(owner);
  const starts = [];
  const spans = [];
  (function visit(node) {
    if (node !== owner.body && ts.isFunctionLike(node)) return;
    const started = queryRunnerCall(node, checker, 'startTransaction');
    if (started) starts.push({ client: started, start: node.end });
    const committed = queryRunnerCall(node, checker, 'commitTransaction');
    const open = committed && starts.findLast((span) => span.client === committed);
    if (open) spans.push({ ...open, end: node.getStart() });
    ts.forEachChild(node, visit);
  })(owner.body);
  queryRunnerSpans.set(owner, spans);
  return spans;
}

function inCatchOrFinally(node, owner) {
  for (let child = node, parent = node.parent; parent && parent !== owner; child = parent, parent = parent.parent) {
    if (ts.isCatchClause(parent) || (ts.isTryStatement(parent) && parent.finallyBlock === child)) return true;
  }
  return false;
}

// The innermost transaction around `node`, with the name of its client: the callback parameter of a
// `transaction(...)` call, or a TypeORM QueryRunner between startTransaction() and commitTransaction().
function enclosingTransaction(node, checker) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isFunctionLike(parent) || !parent.parent || !ts.isCallExpression(parent.parent)) continue;
    if (!parent.parent.arguments.includes(parent) || !isTransactionCall(parent.parent, checker)) continue;
    const [client] = parent.parameters;
    const name = client && ts.isIdentifier(client.name) ? client.name.text : undefined;
    return { client: name, manager: name };
  }
  const owner = enclosingFunction(node);
  if (!owner?.body || inCatchOrFinally(node, owner)) return;
  const span = transactionSpans(owner, checker).find(({ start, end }) => start <= node.getStart() && node.end <= end);
  if (span) return { client: span.client, manager: `${span.client}.manager` };
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
  return `\`${written}()\`, which reaches \`${io.label}\` through ${io.via.map((name) => `\`${name}()\``).join(' -> ')},`;
}

function message(work, call, manager) {
  const target = describeTarget(work, call);
  if (work.kind === 'escape') {
    const handle = manager ? `\`${manager}\`` : 'the transaction manager';
    const example = manager ? `\`${manager}.getRepository(Entity)\`` : '`manager.getRepository(Entity)`';
    return `Awaiting ${target} inside a database transaction writes through a TypeORM repository or manager that is not bound to the transaction, so the write autocommits on another pooled connection. It is not rolled back when the transaction fails, it can block on rows this transaction has locked, and each request holds two connections. Run it through ${handle} (for example ${example}), or pass ${handle} to the helper that writes.`;
  }
  if (work.kind === 'cpu') {
    return `Awaiting ${target} inside a database transaction callback keeps the transaction's pooled connection and its row or advisory locks held for the whole password hash, tens to hundreds of milliseconds of CPU. Concurrent writers queue on those locks and the pool drains under load. Compute the hash before opening the transaction and pass the result in.`;
  }
  return `Awaiting ${target} inside a database transaction callback keeps the transaction's pooled connection and its row or advisory locks held until the external call returns. Slow upstreams exhaust the pool and serialize writers. Do the call before opening the transaction, or after commit (write an outbox row for side effects that must follow the data). Caveat: a side effect cannot roll back with the transaction, so a failure after it needs compensation.`;
}

function check(node, context) {
  if (!isAwaited(node) || TEST_FILE.test(node.getSourceFile().fileName.replaceAll('\\', '/'))) return;
  const transaction = enclosingTransaction(node, context.checker);
  if (!transaction || receivesClient(node, transaction.client)) return;
  const work =
    workOf(node, slowWork, context.checker, PROJECT_RESOLUTION_DEPTH, new Set()) ??
    workOf(node, escapedWrite, context.checker, PROJECT_RESOLUTION_DEPTH, new Set());
  if (!work) return;
  const reportNode = calledName(ts.skipOuterExpressions(node.expression)) ?? node;
  const rule = work.kind === 'escape' ? 'typeorm-transaction-client-escape' : 'external-call-in-transaction';
  context.report(reportNode, rule, message(work, node, transaction.manager));
}

module.exports = { check };
