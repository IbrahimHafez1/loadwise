'use strict';

const { requireReview, ts, enclosingStatement, enclosingIteration } = require('./helpers.cjs');
const { calleeName } = require('../call-syntax.cjs');
const { catchRepeatsEscapedCall } = require('../promise-return-escapes-catch.cjs');

// Helpers named like events, telemetry or cache warm-ups are often meant to run in the background.
const backgroundWorkName =
  /^(?:publish|emit|notify|track|log|send|dispatch|enqueue|schedule|trigger|broadcast|warm|prefetch|refresh|report)/i;

function isAsync(owner) {
  return Boolean(owner.modifiers?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword));
}

function returnAwait({ node }) {
  const statement = node && enclosingStatement(node);
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return;
  const value = statement.expression;
  if (!ts.isCallExpression(value) && !ts.isIdentifier(value)) return;
  if (catchRepeatsEscapedCall(statement)) return;
  let guarded = false;
  let closesIterator = false;
  for (let child = statement, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      if (!guarded || parent.asteriskToken || !isAsync(parent)) return;
      return {
        edits: [{ start: value.getStart(), end: value.getStart(), text: 'await ' }],
        requiresReview: true,
        note:
          'Rejected promises will now run this catch handler. Verify its recovery, response-writing, logging and retry behavior.' +
          (closesIterator
            ? ' The surrounding for...of loop now closes its iterator after the promise settles, which matters only for generators with cleanup.'
            : ''),
      };
    }
    if (ts.isForOfStatement(parent)) closesIterator = true;
    // Waiting here would change when a `using` resource is disposed.
    if (
      ts.isBlock(parent) &&
      parent.statements.some(
        (sibling) => ts.isVariableStatement(sibling) && sibling.declarationList.flags & ts.NodeFlags.Using,
      )
    )
      return;
    if (ts.isTryStatement(parent)) {
      if (parent.finallyBlock) return;
      if (parent.catchClause && child === parent.tryBlock) guarded = true;
    }
  }
}

// `await` keeps the call in the same place, so later statements now run after it settles and its rejection reaches
// the caller instead of becoming an unhandled rejection.
function awaitFloatingCall({ finding, node }) {
  const statement = node && enclosingStatement(node);
  if (!statement || !ts.isExpressionStatement(statement)) return;
  const call = ts.skipOuterExpressions(statement.expression);
  // The forEach finding points at the method name; rewriting that loop is a different change.
  if (!ts.isCallExpression(call) || call.getStart() !== node.getStart()) return;
  const owner = ts.findAncestor(statement, ts.isFunctionLike);
  if (!owner || !isAsync(owner) || owner.asteriskToken) return;
  const inLoop = enclosingIteration(statement)?.kind === 'loop';
  const looksLikeBackgroundWork = backgroundWorkName.test(calleeName(call) ?? '');
  const requiresReview = inLoop || looksLikeBackgroundWork || Boolean(finding.contextualReason);
  return {
    edits: [{ start: call.getStart(), end: call.getStart(), text: 'await ' }],
    ...(requiresReview && { requiresReview: true }),
    note: inLoop
      ? 'Each iteration now waits for this call before the next one starts. Use Promise.all if the calls are independent and may run together.'
      : requiresReview
        ? 'The caller now waits for this call and receives its rejection. Confirm it was not meant to run in the background; if it was, use `void` with `.catch(handler)` instead.'
        : 'The caller now waits for this call and receives its rejection instead of carrying on before it finishes.',
  };
}

module.exports = {
  'promise-return-escapes-catch': returnAwait,
  'floating-promise': requireReview(
    'The caller now waits for the call and receives its rejection, which changes ordering and error handling.',
    awaitFloatingCall,
  ),
};
