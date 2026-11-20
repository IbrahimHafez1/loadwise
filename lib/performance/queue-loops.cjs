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

function isQueueAdd(call, context) {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'add' &&
    context.isPackageType(callee.expression, QUEUE_PACKAGES, QUEUE_TYPE_NAMES)
  );
}

// Per declaration: the queue `add` call a project wrapper makes once per call, if any.
const wrappedAdds = new WeakMap();

// A project function such as `private add(job) { return this.queue.add(job.name, job) }` that enqueues one job.
function wrappedQueueAdd(call, context) {
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration) || !declaration.body) return;
  if (declaration.getSourceFile().isDeclarationFile) return;
  if (!wrappedAdds.has(declaration)) {
    let found;
    (function visit(node) {
      if (found || (node !== declaration.body && ts.isFunctionLike(node))) return;
      if (ts.isCallExpression(node) && isQueueAdd(node, context) && !findRepeatOwner(node, context.checker))
        found = node;
      else ts.forEachChild(node, visit);
    })(declaration.body);
    wrappedAdds.set(declaration, found);
  }
  return wrappedAdds.get(declaration);
}

function check(node, context) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee)) return;
  if (!context.isRepeated(node)) return;
  const direct = isQueueAdd(node, context);
  const wrapped = !direct && wrappedQueueAdd(node, context);
  if (!direct && !wrapped) return;
  const owner = findRepeatOwner(node, context.checker);
  if (!owner || isSequentialByDesign(node, owner) || iteratesArrayLiteral(owner)) return;
  if (wrapped) {
    const label = queueLabel(wrapped.expression.expression);
    // Reported on the whole callee: the addBulk rewrite applies only to a direct Queue.add.
    context.report(
      callee,
      'queue-add-in-loop',
      `\`${callee.getText()}()\` enqueues one job per item through \`${label}.add\`, and each call is its own Redis round trip (a MULTI/EXEC script). Add a variant that collects the jobs and sends them with \`${label}.addBulk(jobs)\` in one call. Ignore if a later job needs the earlier job's result or id.`,
    );
    return;
  }
  const label = queueLabel(callee.expression);
  context.report(
    callee.name,
    'queue-add-in-loop',
    `\`${label}.add\` enqueues one job per item, and each call is its own Redis round trip (a MULTI/EXEC script). Collect the jobs and send them with \`${label}.addBulk(jobs)\` in one call. Ignore if a later job needs the earlier job's result or id.`,
  );
}

module.exports = { check, wrappedQueueAdd };
