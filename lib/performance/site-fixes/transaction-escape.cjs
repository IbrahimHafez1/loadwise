'use strict';

const { requireReview, ts, ancestor, textOf, replaceNode } = require('./helpers.cjs');
const { declaresName } = require('./scope-names.cjs');

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// The transaction callback that owns `managerName` as its first parameter.
function managerCallback(node, managerName) {
  return ancestor(node, (current) => {
    if (!ts.isFunctionLike(current)) return false;
    const [first] = current.parameters;
    return Boolean(first && ts.isIdentifier(first.name) && first.name.text === managerName);
  });
}

// Runs a write on the transaction's manager instead of a repository or manager outside it. The rule records which
// kind of receiver it saw, so a repository is bound with `withRepository` and a manager is swapped for the callback's.
function runOnTransactionManager({ finding, node }) {
  const { transactionReceiver: receiverKind, transactionManager: managerName } = finding;
  if (!receiverKind || !IDENTIFIER.test(managerName ?? '')) return;
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== node) return;
  const callback = managerCallback(node, managerName);
  if (!callback || !callback.body || declaresName(callback.body, managerName)) return;
  const receiver = access.expression;
  return {
    edits: [
      replaceNode(
        receiver,
        receiverKind === 'repository' ? `${managerName}.withRepository(${textOf(receiver)})` : managerName,
      ),
    ],
    note:
      receiverKind === 'repository'
        ? '`withRepository` needs TypeORM 0.3.0 or newer.'
        : 'The manager variable replaces the shared one for this call.',
  };
}

module.exports = {
  'typeorm-transaction-client-escape': requireReview(
    'The write now runs on the transaction connection and rolls back with it, instead of committing on its own. If it must persist when the transaction fails (an audit or failure record), move it after the transaction instead.',
    runOnTransactionManager,
  ),
};
