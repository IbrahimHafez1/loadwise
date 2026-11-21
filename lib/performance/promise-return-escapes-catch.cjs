'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { isAsyncFunction } = require('./password-hashing.cjs');

const ruleId = 'promise-return-escapes-catch';
const standardPromiseInterfaces = new Set(['Promise', 'PromiseLike']);

function returnsInsideLocalCatch(statement) {
  let guarded = false;
  for (let child = statement, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return guarded && !parent.asteriskToken && isAsyncFunction(parent);
    if (ts.isTryStatement(parent) && child === parent.tryBlock && parent.catchClause) guarded = true;
  }
  return false;
}

function isStandardPromise(type, checker) {
  if (type.isUnion()) return type.types.every((member) => isStandardPromise(member, checker));
  return (
    type.getProperty('then')?.declarations?.some((declaration) => {
      const owner = declaration.parent;
      return (
        ts.isInterfaceDeclaration(owner) &&
        standardPromiseInterfaces.has(owner.name.text) &&
        isDefaultLibrary(checker, declaration.getSourceFile())
      );
    }) ?? false
  );
}

function checkPromiseReturnEscapesCatch(statement, { checker, report }) {
  if (!statement.expression) return;
  const value = ts.skipOuterExpressions(statement.expression);
  if (ts.isAwaitExpression(value) || !returnsInsideLocalCatch(statement)) return;
  if (!isStandardPromise(checker.getTypeAtLocation(value), checker)) return;
  report(
    statement,
    ruleId,
    'A rejection from this returned promise bypasses the local catch because the try does not await it. Use `return await` inside the try if the catch should handle the rejection.',
  );
}

module.exports = { checkPromiseReturnEscapesCatch };
