'use strict';

// deep-control-flow: lifts the deepest branch one level with the smallest exact if rewrite on its path.
const { ts } = require('./helpers.cjs');
const { nestingEdits, smallest } = require('./if-rewrites.cjs');

function buildDeepControlFlow({ node, offset, sourceFile }) {
  let deepest = node;
  while (deepest && deepest.getStart(sourceFile) === offset && !ts.isStatement(deepest) && !ts.isCatchClause(deepest))
    deepest = deepest.parent;
  if (!deepest || deepest.getStart(sourceFile) !== offset) return;
  const edit = smallest(nestingEdits(deepest, sourceFile), sourceFile.text);
  if (edit) return { edits: [edit] };
}

module.exports = { 'deep-control-flow': buildDeepControlFlow };
