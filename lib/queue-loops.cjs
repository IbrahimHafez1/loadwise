'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { findRepeatOwner } = require('./repeated.cjs');
const { isSequentialByDesign } = require('./sequential-loops.cjs');

const QUEUE_PACKAGES = ['bullmq', 'bull', '@types/bull'];
const QUEUE_TYPE_NAMES = ['Queue'];

// Iterating a fixed array literal is a handful of jobs known at write time, not a per-item fan-out.
function iteratesArrayLiteral(owner) {
  if (ts.isForOfStatement(owner)) return ts.isArrayLiteralExpression(ts.skipOuterExpressions(owner.expression));
  if (!ts.isFunctionLike(owner)) return false;
  const iteration = ts.skipOuterExpressions(owner.parent);
  const call = ts.isCallExpression(iteration) ? iteration : owner.parent;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isArrayLiteralExpression(ts.skipOuterExpressions(call.expression.expression))
  );
}

function queueLabel(receiver) {
  const expression = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'queue';
}

function check(node, context) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'add') return;
  if (!context.isRepeated(node)) return;
  const owner = findRepeatOwner(node, context.checker);
  if (!owner || isSequentialByDesign(node, owner) || iteratesArrayLiteral(owner)) return;
  if (!context.isPackageType(callee.expression, QUEUE_PACKAGES, QUEUE_TYPE_NAMES)) return;
  const label = queueLabel(callee.expression);
  context.report(
    callee.name,
    'queue-add-in-loop',
    `\`${label}.add\` enqueues one job per item, and each call is its own Redis round trip (a MULTI/EXEC script). Collect the jobs and send them with \`${label}.addBulk(jobs)\` in one call. Ignore if a later job needs the earlier job's result or id.`,
  );
}

module.exports = { check };
