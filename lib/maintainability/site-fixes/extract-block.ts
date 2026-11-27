// Moves one statement into a named function and calls it where the statement stood:
//   processRows(rows, seen);
//   ...
//   function processRows(rows: Row[], seen: Set<string>) { ...statement }
// The function is declared after the top-level statement that holds the code, or, inside a class
// method, as a private method next to it called through `this`. Local variables the statement reads
// become parameters, in order of first use. It is offered only when the statement finishes normally
// (no return, no break or continue that leaves it, no await or yield), takes at most four
// parameters, and reassigns none of them, except one outer `let` that the function returns and the
// call assigns back: `total = sumRows(rows, total)`. When the statement only fills one empty
// collection that the line above declares and the code after it uses, the function creates and
// returns that collection instead, and the call declares it: `const seen = buildSeen(rows)`. A
// parameter is a copy taken at the call, so it is refused when a closure could see the variable
// change. In TypeScript every parameter gets the type the checker gives the variable at that spot,
// and the rewritten file must not type-check worse.
import { applyEdits } from '../../shared/fix-hunks.js';
import { typeChecksAsBefore } from './isolated-program.js';
import { extractionEdits, extractionPlan } from './extract-block-edits.js';
import { decisionCount, fitsHunks, measuredEdits, ownStatements } from './extract-block-measure.js';
import type { SourceFile, Statement } from 'typescript';
import type { ExtractionDraft } from '../types/extraction-drafts.js';
import type { FunctionWithBody } from '../types/site-fix-nodes.js';

// The edits that move `statement` out of `fn` into a named function: the call in its place and the
// declaration after the enclosing member or top-level statement, with `typeChecks()` to run once
// the edits are wanted, since it checks the whole rewritten file. Undefined when it would not run
// the same code.
function extractionDraft(
  statement: Statement,
  fn: FunctionWithBody,
  sourceFile: SourceFile,
): ExtractionDraft | undefined {
  const plan = extractionPlan(statement, fn, sourceFile);
  const edits = plan && extractionEdits(plan);
  if (!edits || !fitsHunks(sourceFile, edits)) return;
  const typeChecks = () => !plan.typeScript || typeChecksAsBefore(sourceFile, applyEdits(sourceFile.text, edits));
  return { name: plan.signature.name, edits, typeChecks };
}

// Like extractionDraft, but also undefined when the rewritten file would not type-check the same.
function extractionEdit(
  statement: Statement,
  fn: FunctionWithBody,
  sourceFile: SourceFile,
): Pick<ExtractionDraft, 'name' | 'edits'> | undefined {
  const draft = extractionDraft(statement, fn, sourceFile);
  if (draft?.typeChecks()) return { name: draft.name, edits: draft.edits };
}

export { extractionDraft, extractionEdit, fitsHunks, measuredEdits, ownStatements, decisionCount };
