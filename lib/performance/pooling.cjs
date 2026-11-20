'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { findRepeatOwner, outerExpression } = require('./repeated.cjs');

const drivers = new Map([
  ['pg', { member: 'Pool', declarations: ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'] }],
  ['mongodb', { member: 'MongoClient', declarations: ['mongodb'] }],
  ['@prisma/client', { member: 'PrismaClient', declarations: ['@prisma/client', '.prisma/client'] }],
  ['redis', { member: 'createClient', declarations: ['redis', '@redis/client'] }],
  ['@redis/client', { member: 'createClient', declarations: ['@redis/client'] }],
]);
const httpModules = new Set(['http', 'https', 'node:http', 'node:https']);
const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const importsByFile = new WeakMap();

// An identifier in a large project rarely names a driver. Index import spellings once,
// then ask the checker about scope only for candidates with a matching local name.
function importedMember(target, checker) {
  const qualified = ts.isPropertyAccessExpression(target);
  const local = qualified ? target.expression : target;
  if (!ts.isIdentifier(local)) return;
  const file = local.getSourceFile();
  let bindings = importsByFile.get(file);
  if (!bindings) {
    bindings = new Map();
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const moduleName = statement.moduleSpecifier.text;
      if (!drivers.has(moduleName) && !httpModules.has(moduleName)) continue;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) bindings.set(clause.name.text, { moduleName, declaration: clause });
      const names = clause.namedBindings;
      if (!names) continue;
      if (ts.isNamespaceImport(names)) bindings.set(names.name.text, { moduleName, declaration: names });
      else
        for (const named of names.elements) {
          if (named.isTypeOnly) continue;
          const member = (named.propertyName ?? named.name).text;
          bindings.set(named.name.text, {
            moduleName,
            member: member === 'default' ? undefined : member,
            declaration: named,
          });
        }
    }
    importsByFile.set(file, bindings);
  }
  const binding = bindings.get(local.text);
  if (!binding || qualified === Boolean(binding.member)) return;
  if (!checker.getSymbolAtLocation(local)?.declarations?.includes(binding.declaration)) return;
  return { moduleName: binding.moduleName, member: qualified ? target.name.text : binding.member };
}

function requestHandlerOwner(node, context) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isPropertyDeclaration(current)) return;
    if (!ts.isFunctionLike(current)) continue;
    if ((!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) || current.asteriskToken) return;
    const handler = outerExpression(current);
    const registration = handler.parent;
    if (!ts.isCallExpression(registration) || registration.arguments.at(-1) !== handler) return;
    const callee = registration.expression;
    const imported = importedMember(callee, context.checker);
    if (
      imported?.member === 'createServer' &&
      httpModules.has(imported.moduleName) &&
      registration.arguments.length <= 2
    )
      return current;
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !routeMethods.has(callee.name.text) ||
      registration.arguments.length < 2
    )
      return;
    const router = callee.expression;
    if (
      context.isPackageType(
        router,
        ['@types/express', '@types/express-serve-static-core', 'express-serve-static-core'],
        ['Express', 'Application', 'Router', 'IRouter'],
      ) ||
      context.isPackageType(router, ['fastify'], ['FastifyInstance'])
    )
      return current;
    return;
  }
}

function guardsSharedBinding(guard, destination, owner, checker) {
  if (
    !ts.isIdentifier(destination) ||
    !ts.isBinaryExpression(guard) ||
    (guard.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken &&
      guard.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
  )
    return false;
  const left = ts.skipOuterExpressions(guard.left);
  const right = ts.skipOuterExpressions(guard.right);
  const leftIsRead = ts.isIdentifier(left) && left.text === destination.text;
  const read = leftIsRead ? left : right;
  const sentinel = leftIsRead ? right : left;
  if (!ts.isIdentifier(read) || read.text !== destination.text) return false;
  if (
    sentinel.kind !== ts.SyntaxKind.NullKeyword &&
    !(
      ts.isIdentifier(sentinel) &&
      sentinel.text === 'undefined' &&
      checker.getTypeAtLocation(sentinel).flags & ts.TypeFlags.Undefined
    )
  )
    return false;
  const symbol = checker.getSymbolAtLocation(destination);
  const declaration = symbol?.valueDeclaration;
  return (
    declaration &&
    symbol === checker.getSymbolAtLocation(read) &&
    (declaration.getSourceFile() !== owner.getSourceFile() ||
      declaration.pos < owner.pos ||
      declaration.end > owner.end)
  );
}

function cachedInitialization(node, owner, checker) {
  let destination;
  for (let child = node, parent = node.parent; parent && parent !== owner; child = parent, parent = parent.parent) {
    if (ts.isBinaryExpression(parent) && parent.right === child) {
      const operator = parent.operatorToken.kind;
      if (
        [
          ts.SyntaxKind.QuestionQuestionEqualsToken,
          ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
        ].includes(operator)
      )
        return true;
      if (operator === ts.SyntaxKind.EqualsToken) destination = ts.skipOuterExpressions(parent.left);
    }
    if (destination && ts.isIfStatement(parent) && child === parent.thenStatement) {
      const guard = ts.skipOuterExpressions(parent.expression);
      if (
        ts.isPrefixUnaryExpression(guard) &&
        guard.operator === ts.SyntaxKind.ExclamationToken &&
        ts.skipOuterExpressions(guard.operand).getText() === destination.getText()
      )
        return true;
      if (guardsSharedBinding(guard, destination, owner, checker)) return true;
    }
  }
  return false;
}

function verifiedDriver(target, driver, checker) {
  const declarations = checker.getTypeAtLocation(target).getSymbol()?.declarations;
  return declarations?.some((declaration) => {
    const path = declaration.getSourceFile().fileName.replaceAll('\\', '/');
    const marker = '/node_modules/';
    const start = path.lastIndexOf(marker);
    if (start < 0) return false;
    const withinModules = path.slice(start + marker.length);
    return driver.declarations.some((name) => withinModules.startsWith(name + '/'));
  });
}

function checkLostCheckout(query, context) {
  if (!query.arguments.length || ts.isOptionalChain(query)) return;
  const client = ts.skipOuterExpressions(query.expression.expression);
  if (!ts.isAwaitExpression(client)) return;
  const connect = ts.skipOuterExpressions(client.expression);
  if (
    !ts.isCallExpression(connect) ||
    connect.arguments.length ||
    !ts.isPropertyAccessExpression(connect.expression) ||
    connect.expression.name.text !== 'connect' ||
    ts.isOptionalChain(connect)
  )
    return;
  const pg = drivers.get('pg').declarations;
  if (
    !context.isPackageType(connect.expression.expression, pg, ['Pool']) ||
    !context.isPackageType(client, pg, ['PoolClient'])
  )
    return;
  context.report(
    connect,
    'pg-unreleased-checkout',
    'This checkout discards the client after one query(), so it can never be released and leaks a pooled connection. Call `pool.query()` for a single statement, or keep `client` and call `client.release()` in finally.',
  );
}

function checkPoolCreation(node, context) {
  const target = node.expression;
  const constructing = ts.isNewExpression(node);
  if (!constructing && ts.isPropertyAccessExpression(target)) {
    if (target.name.text === 'query') checkLostCheckout(node, context);
    if (target.name.text !== 'createClient') return;
  }
  const imported = importedMember(target, context.checker);
  const driver = imported && drivers.get(imported.moduleName);
  if (!driver || imported.member !== driver.member || constructing === (driver.member === 'createClient')) return;
  const owner = findRepeatOwner(node, context.checker) || requestHandlerOwner(node, context);
  if (!owner || cachedInitialization(node, owner, context.checker) || !verifiedDriver(target, driver, context.checker))
    return;
  context.report(
    node,
    'pool-created-per-request-or-item',
    `${imported.moduleName}.${driver.member} creates a new client or pool on a repeated path, paying connection setup each time and risking connection exhaustion. Create it once at module scope and reuse it; close it at shutdown.`,
  );
}

module.exports = { checkPoolCreation };
