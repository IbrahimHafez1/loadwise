import { ts, ancestor, hasCommentBetween, lineStart, replaceNode } from '../../performance/site-fixes/helpers.js';
import { closestTypeofName, containerStatements, nanComparedOperand, unreachableRun } from '../suspicious-logic.js';
import { isEqualityOperator, isNegatedEquality } from '../source-helpers.js';
import type { BinaryExpression, Node, Statement } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.js';

// The finding sits at the start of its expression, which nested operands share, so take the
// innermost matching binary expression that starts there.
function binaryStartingAt(node: Node, matchesOperator: (kind: number) => boolean): BinaryExpression | undefined {
  const start = node.getStart();
  return ancestor(
    node,
    (candidate): candidate is BinaryExpression =>
      ts.isBinaryExpression(candidate) &&
      candidate.getStart() === start &&
      matchesOperator(candidate.operatorToken.kind),
  );
}

function replaceOperator(binary: BinaryExpression, operator: string): TextEdit {
  return replaceNode(binary.operatorToken, operator);
}

function assignmentFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const assignment = binaryStartingAt(node, (kind) => kind === ts.SyntaxKind.EqualsToken);
  if (!assignment) return;
  return {
    edits: [replaceOperator(assignment, '===')],
    note: 'The condition no longer assigns, so later code that relied on the new value of the variable needs the assignment as its own statement.',
    requiresReview: true,
  };
}

function nanFix({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const comparison = binaryStartingAt(node, isEqualityOperator);
  const operand = comparison && nanComparedOperand(comparison);
  // The whole comparison is rebuilt from its operand, which would drop a comment inside it.
  if (!comparison || !operand || hasCommentBetween(text, comparison.getStart(), comparison.end)) return;
  const negated = isNegatedEquality(comparison.operatorToken.kind);
  return {
    edits: [replaceNode(comparison, `${negated ? '!' : ''}Number.isNaN(${operand.getText()})`)],
    note: 'Number.isNaN is true only for the NaN value itself, which is what the comparison was meant to test.',
    // A comparison that was always false (or true) now varies, so a branch that never ran can start running.
    requiresReview: true,
  };
}

function typeofFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const literal = ancestor(node, ts.isStringLiteral);
  const name = literal && closestTypeofName(literal.text);
  if (!literal || !name) return;
  const quote = literal.getText()[0];
  return {
    edits: [replaceNode(literal, `${quote}${name}${quote}`)],
    note: `'${literal.text}' looks like a misspelling of '${name}'.`,
    // The comparison could never match before; once it can, the branch it guards starts running.
    requiresReview: true,
  };
}

// Removes the statement's whole line when nothing else shares it, so no blank indented line is left.
function deleteStatement(text: string, statement: Statement): TextEdit {
  const start = statement.getStart();
  const lineBegin = lineStart(text, start);
  const newline = text.indexOf('\n', statement.end);
  const lineEnd = newline === -1 ? text.length : newline;
  const aloneOnLine = !text.slice(lineBegin, start).trim() && !text.slice(statement.end, lineEnd).trim();
  if (!aloneOnLine) return { start, end: statement.end, text: '' };
  return { start: lineBegin, end: Math.min(lineEnd + 1, text.length), text: '' };
}

// A `var` is hoisted to the function, so deleting its declaration turns an earlier read from undefined into a
// ReferenceError.
function declaresVar(node: Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) return true;
  return ts.forEachChild(node, (child) => declaresVar(child) || undefined) ?? false;
}

function unreachableFix({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const statement = ancestor(node, (candidate) => {
    const siblings = candidate.parent && containerStatements(candidate.parent);
    return siblings !== undefined && siblings.some((sibling) => sibling === candidate);
  });
  const siblings = statement?.parent && containerStatements(statement.parent);
  const run = siblings && unreachableRun(siblings);
  if (!run || run.unreachable[0] !== statement || run.unreachable.some(declaresVar)) return;
  return {
    edits: run.unreachable.map((unreachable) => deleteStatement(text, unreachable)),
    note: 'Deleting the code loses it for good. If the exit is a leftover from debugging, remove the exit instead.',
    requiresReview: true,
  };
}

function loopBoundFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const condition = binaryStartingAt(node, (kind) => kind === ts.SyntaxKind.LessThanEqualsToken);
  if (!condition) return;
  return {
    edits: [replaceOperator(condition, '<')],
    note: 'Valid indexes run from 0 to length - 1, so the loop stops before length.',
    // Code after the loop, or a body that relies on the extra pass, sees one iteration fewer.
    requiresReview: true,
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'assignment-in-condition': assignmentFix,
  'nan-comparison': nanFix,
  'invalid-typeof-comparison': typeofFix,
  'unreachable-code': unreachableFix,
  'loop-index-past-length': loopBoundFix,
};

export default builders;
