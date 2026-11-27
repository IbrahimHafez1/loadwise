// deep-control-flow: lifts the deepest branch one level with the smallest exact if rewrite on its
// path, or moves one statement on that path into a named function. Every candidate is measured with
// the checker itself, and one that brings the function under the nesting limit wins over one that
// only lowers its depth.
import { ts, functionWithBody } from './helpers.js';
import { nestingEdits, smallest } from './if-rewrites.js';
import { extractionDraft, measuredEdits } from './extract-block.js';
import type { Node, SourceFile, Statement } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.js';
import type { ExtractionDraft } from '../types/extraction-drafts.js';
import type { FunctionWithBody } from '../types/site-fix-nodes.js';

// A way to lower the nesting: a plain rewrite, or an extraction that names the new function and
// checks its types.
interface Candidate {
  edits: TextEdit[];
  name?: string;
  typeChecks?: ExtractionDraft['typeChecks'];
}

const ruleId = 'deep-control-flow';

// Statements from `deepest` up to the function body as extractions. A loop is the most natural unit
// to name, so loops come first, each group smallest first. Each one is built lazily, and its type
// check is left to the caller.
function* extractions(deepest: Node, fn: FunctionWithBody, sourceFile: SourceFile): Generator<ExtractionDraft> {
  const statements: Statement[] = [];
  for (let node: Node | undefined = deepest; node && node !== fn.body; node = node.parent)
    if (ts.isStatement(node) && ts.isBlock(node.parent)) statements.push(node);
  const lines = (statement: Statement) =>
    sourceFile.text.slice(statement.getStart(sourceFile), statement.end).split('\n').length;
  const loop = (statement: Statement) => Number(ts.isIterationStatement(statement, false));
  statements.sort((left, right) => loop(right) - loop(left) || lines(left) - lines(right));
  for (const statement of statements) {
    const extraction = extractionDraft(statement, fn, sourceFile);
    if (extraction) yield extraction;
  }
}

// The builder registry also passes the offset of the finding, which SiteFixInput does not declare.
type DeepControlFlowInput = SiteFixInput & { offset?: number };

const buildDeepControlFlow: SiteFixBuilder = ({ node, offset, sourceFile }: DeepControlFlowInput) => {
  if (!node || !sourceFile || offset === undefined) return;
  let deepest: Node | undefined = node;
  while (deepest && deepest.getStart(sourceFile) === offset && !ts.isStatement(deepest) && !ts.isCatchClause(deepest))
    deepest = deepest.parent;
  if (!deepest || deepest.getStart(sourceFile) !== offset) return;
  const deepestNode = deepest;
  let owner: Node | undefined = deepestNode.parent;
  while (owner && !functionWithBody(owner)) owner = owner.parent;
  if (!owner) return;
  const fn = owner;
  const rewrite = smallest(nestingEdits(deepestNode, sourceFile), sourceFile.text);
  // Candidates are measured lazily: the checker reruns on the whole rewritten file for each one.
  const candidates = function* (): Generator<Candidate> {
    if (rewrite) yield { edits: [rewrite] };
    yield* extractions(deepestNode, fn, sourceFile);
  };
  let lowered: Candidate | undefined;
  for (const candidate of candidates()) {
    const { before, after, contained } = measuredEdits(sourceFile, fn, ruleId, candidate.edits);
    if (!contained || after >= before || (after > 0 && lowered)) continue;
    if (candidate.typeChecks && !candidate.typeChecks()) continue;
    if (after === 0) return result(candidate);
    lowered ??= candidate;
  }
  if (lowered) return result(lowered);
};

function result({ edits, name }: Candidate): FixResult {
  if (!name) return { edits };
  return { edits, requiresReview: true, note: `Moves the innermost levels into ${name}, called in their place.` };
}

export default { 'deep-control-flow': buildDeepControlFlow };
