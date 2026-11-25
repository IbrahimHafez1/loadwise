import { applyEdits } from '../../shared/fix-hunks.cjs';
import { ts, functionWithBody, flaggedFunction, lineEnd } from './helpers.cjs';
import { analyzeFunctions } from '../functions.cjs';
import { forOwnNodes } from './extract-block-ast.cjs';
import type { Node, SourceFile, Statement } from 'typescript';
import type { Finding, TextEdit } from '../../shared/types.cjs';
import type { MeasuredEdits } from '../types/extraction-drafts.cjs';
import type { FunctionWithBody } from '../types/site-fix-nodes.cjs';
import type { EditGroup } from '../types/extract-block.cjs';

// Mirrors site-fix: longer hunks are rejected, and edits this close print as one hunk.
export const maxHunkLines = 14;
const hunkJoinDistance = 3;

// Whether site-fix would print every hunk of `edits` within its line limit.
export function fitsHunks(sourceFile: SourceFile, edits: readonly TextEdit[]): boolean {
  const text = sourceFile.text;
  const row = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset).line;
  const groups: EditGroup[] = [];
  for (const edit of [...edits].sort((left, right) => left.start - right.start)) {
    const first = row(edit.start);
    const last = row(Math.max(edit.start, edit.end - 1));
    const group = groups.at(-1);
    if (group && first - group.last <= hunkJoinDistance) {
      group.edits.push(edit);
      group.last = Math.max(group.last, last);
    } else groups.push({ first, last, edits: [edit] });
  }
  return groups.every((group) => {
    const start = sourceFile.getPositionOfLineAndCharacter(group.first, 0);
    const before = text.slice(start, lineEnd(text, sourceFile.getPositionOfLineAndCharacter(group.last, 0)));
    const shifted = group.edits.map((edit) => ({ ...edit, start: edit.start - start, end: edit.end - start }));
    const after = applyEdits(before, shifted);
    return before.split('\n').length <= maxHunkLines && after.split('\n').length <= maxHunkLines;
  });
}

// The same node as innermostNodeAt, without visiting subtrees that end before the offset: a finding
// is looked up for every function of the file, on every candidate.
function nodeAt(sourceFile: SourceFile, offset: number): Node | undefined {
  let found: Node | undefined;
  (function descend(node: Node): void {
    if (node.getStart(sourceFile) > offset || offset >= node.end) return;
    found = node;
    ts.forEachChild(node, (child) => {
      if (child.pos > offset || offset >= child.end) return;
      descend(child);
      return true;
    });
  })(sourceFile);
  return found;
}

// The function a finding belongs to: the one it names, or the one whose body holds the reported
// statement.
function ownerOf(sourceFile: SourceFile, finding: Finding): FunctionWithBody | undefined {
  if (finding.line === undefined || finding.column === undefined) return;
  const offset = sourceFile.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
  const node = nodeAt(sourceFile, offset);
  if (!node) return;
  const named = flaggedFunction(node);
  if (named) return named;
  for (let current: Node | undefined = node.parent; current; current = current.parent)
    if (functionWithBody(current)) return current;
}

// Where each finding's function starts (-1 for none). The findings of one parsed file are measured
// once per candidate.
const ownerStarts = new WeakMap<Finding, number>();
function ownerStartOf(sourceFile: SourceFile, finding: Finding): number {
  let start = ownerStarts.get(finding);
  if (start === undefined) {
    start = ownerOf(sourceFile, finding)?.getStart(sourceFile) ?? -1;
    ownerStarts.set(finding, start);
  }
  return start;
}

// The value the checker reports for `ruleId` on the function starting at `functionStart` (0 when it
// is under the threshold), and how many other functions in the file the rule reports.
function measure(
  sourceFile: SourceFile,
  findings: readonly Finding[],
  functionStart: number,
  ruleId: string,
): { value: number; others: number } {
  let value = 0;
  let others = 0;
  for (const finding of findings) {
    if (finding.ruleId !== ruleId) continue;
    if (ownerStartOf(sourceFile, finding) === functionStart) value = Number(/\d+/.exec(finding.message)?.[0]);
    else others++;
  }
  return { value, others };
}

// Every candidate gets a fresh measurement. Candidates from one parsed source share its original
// findings.
const originalFindings = new WeakMap<SourceFile, readonly Finding[]>();
export function measuredEdits(sourceFile: SourceFile, fn: Node, ruleId: string, edits: TextEdit[]): MeasuredEdits {
  const start = fn.getStart(sourceFile);
  let original = originalFindings.get(sourceFile);
  if (!original) {
    original = analyzeFunctions(sourceFile, sourceFile.fileName);
    originalFindings.set(sourceFile, original);
  }
  const before = measure(sourceFile, original, start, ruleId);
  const rewritten = ts.createSourceFile(
    sourceFile.fileName,
    applyEdits(sourceFile.text, edits),
    ts.ScriptTarget.Latest,
    true,
  );
  const after = measure(rewritten, analyzeFunctions(rewritten, rewritten.fileName), start, ruleId);
  return { before: before.value, after: after.value, contained: after.others <= before.others };
}

// Statements of `fn` that run as part of its own body, outermost first.
export function ownStatements(fn: FunctionWithBody): Statement[] {
  const statements: Statement[] = [];
  forOwnNodes(fn.body, (node: Node) => {
    if (node !== fn.body && functionWithBody(node)) return false;
    if (ts.isStatement(node) && ts.isBlock(node.parent) && node.parent !== node) statements.push(node);
  });
  return statements;
}

// Decisions the checker counts inside `statement` for its own function.
export function decisionCount(statement: Statement): number {
  let count = 0;
  forOwnNodes(statement, (node: Node) => {
    if (node !== statement && functionWithBody(node)) return false;
    if (
      ts.isIfStatement(node) ||
      ts.isIterationStatement(node, false) ||
      ts.isSwitchStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node)
    )
      count++;
  });
  return count;
}
