'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { findRepeatOwner } = require('./repeated.cjs');
const { isBatchCollection, shouldReportLoopQuery } = require('./query-loops.cjs');

function isTypeormTransaction(expression, checker) {
  const call = ts.skipOuterExpressions(expression);
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  if (call.expression.name.text !== 'transaction' || !call.arguments.length) return false;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !ts.isMethodDeclaration(declaration)) return false;
  const owner = declaration.parent;
  if (!ts.isClassDeclaration(owner) || !['DataSource', 'EntityManager'].includes(owner.name?.text)) return false;
  const file = declaration.getSourceFile();
  const path = file.fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = path.lastIndexOf(marker);
  return file.isDeclarationFile && start >= 0 && path.slice(start + marker.length).startsWith('typeorm/');
}

function executesTransaction(method, checker) {
  for (const statement of method.body.statements) {
    if (ts.isReturnStatement(statement) || ts.isExpressionStatement(statement)) {
      let expression = statement.expression && ts.skipOuterExpressions(statement.expression);
      if (expression && ts.isAwaitExpression(expression)) expression = expression.expression;
      if (expression && isTypeormTransaction(expression, checker)) return true;
      if (ts.isReturnStatement(statement)) return false;
    }
    if (ts.isThrowStatement(statement)) return false;
  }
  return false;
}

function receivesBatch(argument, owner, checker) {
  if (isBatchCollection(argument, owner, checker)) return true;
  // A row worker and a chunk worker can be called with the same map/forEach syntax.
  if (!ts.isFunctionLike(owner)) return false;
  const symbol = checker.getTypeAtLocation(argument).getSymbol();
  return (
    (symbol?.name === 'Array' || symbol?.name === 'ReadonlyArray') &&
    symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
  );
}

function createTransactionLoopCheck(sourceFile, checker) {
  // The call and the implementation must occur in this file.
  if (!sourceFile.text.includes('transaction')) return;
  const transactions = new WeakMap();
  return (call, context) => {
    const access = call.expression;
    if (!ts.isPropertyAccessExpression(access) || access.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
    if (!ts.isAwaitExpression(call.parent) || !call.arguments.length) return;
    const owner = findRepeatOwner(call, checker);
    if (!owner || !shouldReportLoopQuery(call, checker, { owner })) return;
    // An explicit retry or polling loop can require a fresh transaction on each attempt.
    if (
      !ts.isFunctionLike(owner) &&
      !ts.isForOfStatement(owner) &&
      !(
        ts.isForStatement(owner) &&
        owner.condition &&
        ts.isBinaryExpression(owner.condition) &&
        ts.isPropertyAccessExpression(owner.condition.right) &&
        owner.condition.right.name.text === 'length'
      )
    )
      return;
    const method = checker.getSymbolAtLocation(access.name)?.valueDeclaration;
    if (!method || !ts.isMethodDeclaration(method) || !method.body || method.asteriskToken) return;
    if (!(ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Private) && !ts.isPrivateIdentifier(method.name))
      return;
    if (method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.Decorator)) return;
    if (method.parent !== ts.findAncestor(call, ts.isClassLike)) return;
    if (!transactions.has(method)) transactions.set(method, executesTransaction(method, checker));
    if (!transactions.get(method) || call.arguments.some((argument) => receivesBatch(argument, owner, checker))) return;
    context.report(
      access.name,
      'typeorm-transaction-in-loop',
      `${access.name.text}() can open a TypeORM transaction on every iteration, costing a BEGIN and COMMIT round trip per item. Open one transaction around the loop, or process bounded chunks with \`manager.insert()\`; keep per-item rollback needs.`,
    );
  };
}

module.exports = { createTransactionLoopCheck };
