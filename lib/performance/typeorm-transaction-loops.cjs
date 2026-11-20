'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { findRepeatOwner, outerExpression } = require('./repeated.cjs');
const { isBatchCollection, shouldReportLoopQuery } = require('./query-loops.cjs');
const { isolatesEachItem } = require('./sequential-loops.cjs');

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

// The `transaction()` call a method runs as its work, if it only wraps one.
function executedTransaction(method, checker) {
  for (const statement of method.body.statements) {
    if (ts.isReturnStatement(statement) || ts.isExpressionStatement(statement)) {
      let expression = statement.expression && ts.skipOuterExpressions(statement.expression);
      if (expression && ts.isAwaitExpression(expression)) expression = expression.expression;
      if (expression && isTypeormTransaction(expression, checker)) return ts.skipOuterExpressions(expression);
      if (ts.isReturnStatement(statement)) return;
    }
    if (ts.isThrowStatement(statement)) return;
  }
}

// `manager.transaction()` on a manager parameter that the loop fills with the manager of an enclosing
// `transaction(async (manager) => ...)` callback: TypeORM runs the nested call as a SAVEPOINT.
function nestedManager(call, method, transaction, checker) {
  const receiver = ts.skipOuterExpressions(transaction.expression.expression);
  if (!ts.isIdentifier(receiver)) return;
  const index = method.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === receiver.text,
  );
  const argument = index >= 0 && call.arguments[index] && ts.skipOuterExpressions(call.arguments[index]);
  if (!argument || !ts.isIdentifier(argument)) return;
  const parameter = checker.getSymbolAtLocation(argument)?.valueDeclaration;
  const callback = parameter && ts.isParameter(parameter) ? parameter.parent : undefined;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
  const opener = outerExpression(callback).parent;
  if (ts.isCallExpression(opener) && isTypeormTransaction(opener, checker)) return receiver.text;
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

const transactionWrappers = new WeakMap();

// The private same-class method a per-item loop calls when that method only runs a TypeORM transaction.
function transactionLoopTarget(call, checker) {
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
  if (!(ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Private) && !ts.isPrivateIdentifier(method.name)) return;
  if (method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.Decorator)) return;
  if (method.parent !== ts.findAncestor(call, ts.isClassLike)) return;
  if (!transactionWrappers.has(method)) transactionWrappers.set(method, executedTransaction(method, checker));
  const transaction = transactionWrappers.get(method);
  if (!transaction || call.arguments.some((argument) => receivesBatch(argument, owner, checker))) return;
  return { access, owner, savepointManager: nestedManager(call, method, transaction, checker) };
}

function loopMessage(name, isolated, savepointManager) {
  if (savepointManager) {
    const nested = `${name}() runs \`${savepointManager}.transaction()\` on the surrounding transaction's manager for every item, which TypeORM sends as a SAVEPOINT and RELEASE SAVEPOINT round trip pair per item on top of the work inside.`;
    return isolated
      ? `${nested} The savepoint and the per-item try/catch keep one failed item from undoing the others, so keep them where rows can fail; to cut round trips, load the per-item reads in bulk before the loop or validate rows up front.`
      : `${nested} Nothing in the loop catches a failed item, so the savepoint isolates nothing and the error still rolls back the outer transaction: run the work on the outer manager directly, or batch it with \`manager.insert()\`.`;
  }
  // A per-item try/catch keeps one failed item from rolling back the others, which one transaction
  // around the loop would break, so the advice differs.
  return isolated
    ? `${name}() opens a TypeORM transaction for every item, costing a BEGIN and COMMIT round trip per item on top of the work inside. The per-item try/catch keeps one failed item from undoing the others, so do not just wrap the loop in one transaction: load the per-item reads in bulk before the loop, or process bounded chunks in one transaction with a savepoint per item.`
    : `${name}() can open a TypeORM transaction on every iteration, costing a BEGIN and COMMIT round trip per item. Open one transaction around the loop, or process bounded chunks with \`manager.insert()\`; keep per-item rollback needs.`;
}

function createTransactionLoopCheck(sourceFile, checker) {
  // The call and the implementation must occur in this file.
  if (!sourceFile.text.includes('transaction')) return;
  return (call, context) => {
    const target = transactionLoopTarget(call, checker);
    if (!target) return;
    const message = loopMessage(target.access.name.text, isolatesEachItem(call, target.owner), target.savepointManager);
    context.report(target.access.name, 'typeorm-transaction-in-loop', message);
  };
}

module.exports = { createTransactionLoopCheck, transactionLoopTarget };
