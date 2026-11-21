'use strict';

const { ts, enclosingStatement } = require('./helpers.cjs');

function returnAwait({ node }) {
  const statement = node && enclosingStatement(node);
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return;
  const value = statement.expression;
  if (!ts.isCallExpression(value) && !ts.isIdentifier(value)) return;
  let guarded = false;
  for (let child = statement, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      if (
        !guarded ||
        parent.asteriskToken ||
        !parent.modifiers?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword)
      )
        return;
      return {
        edits: [{ start: value.getStart(), end: value.getStart(), text: 'await ' }],
        requiresReview: true,
        note: 'Rejected promises will now run this catch handler. Verify its recovery, response-writing, logging and retry behavior.',
      };
    }
    // Waiting here may change when a surrounding resource or iterator is closed.
    if (
      ts.isForOfStatement(parent) ||
      (ts.isBlock(parent) &&
        parent.statements.some(
          (sibling) => ts.isVariableStatement(sibling) && sibling.declarationList.flags & ts.NodeFlags.Using,
        ))
    )
      return;
    if (ts.isTryStatement(parent)) {
      if (parent.finallyBlock) return;
      if (parent.catchClause && child === parent.tryBlock) guarded = true;
    }
  }
}

module.exports = { 'promise-return-escapes-catch': returnAwait };
