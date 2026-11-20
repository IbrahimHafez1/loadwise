'use strict';

// deep-control-flow: lifts the deepest branch one level with the smallest exact if rewrite on its path, or moves
// one statement on that path into a named function. Every candidate is measured with the checker itself, and
// one that brings the function under the nesting limit wins over one that only lowers its depth.
const { ts, functionWithBody } = require('./helpers.cjs');
const { nestingEdits, smallest } = require('./if-rewrites.cjs');
const { extractionEdit, measuredEdits } = require('./extract-block.cjs');

const ruleId = 'deep-control-flow';

// Statements from `deepest` up to the function body as extractions. A loop is the most natural unit to name, so
// loops come first, each group smallest first. Each one is built lazily, since building it type-checks the file.
function* extractions(deepest, fn, sourceFile) {
  const statements = [];
  for (let node = deepest; node && node !== fn.body; node = node.parent)
    if (ts.isStatement(node) && ts.isBlock(node.parent)) statements.push(node);
  const lines = (statement) => sourceFile.text.slice(statement.getStart(sourceFile), statement.end).split('\n').length;
  const loop = (statement) => Number(ts.isIterationStatement(statement, false));
  statements.sort((left, right) => loop(right) - loop(left) || lines(left) - lines(right));
  for (const statement of statements) {
    const extraction = extractionEdit(statement, fn, sourceFile);
    if (extraction) yield extraction;
  }
}

function buildDeepControlFlow({ node, offset, sourceFile }) {
  let deepest = node;
  while (deepest && deepest.getStart(sourceFile) === offset && !ts.isStatement(deepest) && !ts.isCatchClause(deepest))
    deepest = deepest.parent;
  if (!deepest || deepest.getStart(sourceFile) !== offset) return;
  let fn = deepest.parent;
  while (fn && !functionWithBody(fn)) fn = fn.parent;
  if (!fn) return;
  const rewrite = smallest(nestingEdits(deepest, sourceFile), sourceFile.text);
  // Candidates are measured lazily: the checker reruns on the whole rewritten file for each one.
  const candidates = function* () {
    if (rewrite) yield { edits: [rewrite] };
    yield* extractions(deepest, fn, sourceFile);
  };
  let lowered;
  for (const candidate of candidates()) {
    const { before, after, contained } = measuredEdits(sourceFile, fn, ruleId, candidate.edits);
    if (!contained || after >= before) continue;
    if (after === 0) return result(candidate);
    lowered ??= candidate;
  }
  if (lowered) return result(lowered);
}

function result({ edits, name }) {
  if (!name) return { edits };
  return { edits, note: `Moves the innermost levels into ${name}, called in their place.` };
}

module.exports = { 'deep-control-flow': buildDeepControlFlow };
