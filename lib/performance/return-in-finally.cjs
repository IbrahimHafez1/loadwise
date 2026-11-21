'use strict';

const { syntax: ts } = require('./compiler.cjs');

function checkReturnInFinally(statement, { report }) {
  for (let child = statement, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return;
    if (ts.isTryStatement(parent) && child === parent.finallyBlock) {
      report(
        statement,
        'return-in-finally',
        'Returning from `finally` can replace a pending return value or suppress a thrown error. Keep cleanup in `finally` and return from `try`, `catch`, or after the `try` statement.',
      );
      return;
    }
  }
}

module.exports = { checkReturnInFinally };
