'use strict';

// high-branch-complexity: exact rewrites that each remove one decision the checker counts, applied together.
// Nested ifs merge into one condition, adjacent ifs with the same exit share one condition, `x ? true : false`
// becomes a conversion and `if (!x) x = value` becomes `x ||= value`.
const { ts, ownsLines, hasComments, logicalOperand, singleLine, flaggedFunction } = require('./helpers.cjs');
const { mergeNestedIf, editLines, cleanHeader, jumpKinds } = require('./if-rewrites.cjs');

// Larger edits stop reading as an inline fix; site-fix also rejects the whole fix when one hunk is too long.
const maxEditLines = 10;

// Nodes of the function body that count toward its complexity: nested functions and classes count separately.
function ownNodes(body) {
  const nodes = [];
  (function visit(node) {
    nodes.push(node);
    ts.forEachChild(node, (child) => {
      if (!ts.isFunctionLike(child) && !ts.isClassLike(child)) visit(child);
    });
  })(body);
  return nodes;
}

function singleJump(statement) {
  if (ts.isBlock(statement)) return statement.statements.length === 1 && singleJump(statement.statements[0]);
  return jumpKinds.has(statement.kind);
}

// An operand of `||`: only `??`, assignments, commas, conditionals, arrows and yields need parentheses.
function orOperand(expression, sourceFile) {
  const text = expression.getText(sourceFile);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) return text;
  return logicalOperand(expression, sourceFile);
}

// if (a) return x;  if (b) return x;  →  if (a || b) return x;
// Each branch leaves the block, so the second condition only ever ran when the first was false.
function sameExitRuns(block, sourceFile) {
  const edits = [];
  const statements = block.statements;
  const text = sourceFile.text;
  const eligible = (statement) =>
    ts.isIfStatement(statement) &&
    !statement.elseStatement &&
    singleJump(statement.thenStatement) &&
    ownsLines(statement) &&
    !hasComments(statement);
  for (let index = 0; index < statements.length;) {
    const first = statements[index];
    let end = index + 1;
    if (eligible(first)) {
      const exit = first.thenStatement.getText(sourceFile);
      while (
        end < statements.length &&
        eligible(statements[end]) &&
        statements[end].thenStatement.getText(sourceFile) === exit &&
        !text.slice(statements[end - 1].end, statements[end].getStart(sourceFile)).trim()
      )
        end++;
    }
    if (end - index > 1) {
      const run = statements.slice(index, end);
      const operands = run.map((statement) =>
        singleLine(orOperand(statement.expression, sourceFile), statement.expression),
      );
      if (operands.includes(undefined)) {
        index = end;
        continue;
      }
      const condition = operands.join(' || ');
      edits.push({
        start: first.getStart(sourceFile),
        end: run.at(-1).end,
        text: `if (${condition}) ${first.thenStatement.getText(sourceFile)}`,
        removed: run.length - 1,
      });
    }
    index = end;
  }
  return edits;
}

const booleanKinds = new Set([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword]);

// c ? true : false  →  Boolean(c);   c ? false : true  →  !c
function booleanConditional(expression, sourceFile) {
  const { condition, whenTrue, whenFalse } = expression;
  if (!booleanKinds.has(whenTrue.kind) || !booleanKinds.has(whenFalse.kind) || whenTrue.kind === whenFalse.kind) return;
  if (hasComments(expression)) return;
  const conditionText = condition.getText(sourceFile);
  const tight =
    ts.isIdentifier(condition) || ts.isPropertyAccessExpression(condition) || ts.isCallExpression(condition);
  // Any tighter operator around the conditional already needed parentheses, so the shorter form fits in place.
  const text =
    whenTrue.kind === ts.SyntaxKind.TrueKeyword
      ? `Boolean(${conditionText})`
      : tight
        ? '!' + conditionText
        : `!(${conditionText})`;
  return { start: expression.getStart(sourceFile), end: expression.end, text, removed: 1 };
}

// A target that `||=` reads and writes exactly as often as the original if did.
function simpleTarget(expression) {
  if (ts.isIdentifier(expression)) return true;
  return (
    ts.isPropertyAccessExpression(expression) &&
    !expression.questionDotToken &&
    (ts.isIdentifier(expression.expression) || expression.expression.kind === ts.SyntaxKind.ThisKeyword)
  );
}

// if (!x) x = value;  →  x ||= value;
function logicalAssignment(statement, sourceFile) {
  if (statement.elseStatement || !ownsLines(statement) || hasComments(statement) || !cleanHeader(statement, sourceFile))
    return;
  const condition = statement.expression;
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return;
  let body = statement.thenStatement;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return;
    body = body.statements[0];
  }
  if (!ts.isExpressionStatement(body) || !ts.isBinaryExpression(body.expression)) return;
  const assignment = body.expression;
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !simpleTarget(assignment.left)) return;
  const target = assignment.left.getText(sourceFile);
  if (condition.operand.getText(sourceFile) !== target) return;
  return {
    start: statement.getStart(sourceFile),
    end: statement.end,
    text: `${target} ||= ${assignment.right.getText(sourceFile)};`,
    removed: 1,
  };
}

function rewrites(fn, sourceFile) {
  const edits = [];
  for (const node of ownNodes(fn.body)) {
    if (ts.isBlock(node) || ts.isSourceFile(node)) edits.push(...sameExitRuns(node, sourceFile));
    if (ts.isIfStatement(node)) {
      const merged = mergeNestedIf(node, sourceFile);
      if (merged) edits.push({ ...merged, removed: 1 });
      const assigned = logicalAssignment(node, sourceFile);
      if (assigned) edits.push(assigned);
    }
    if (ts.isConditionalExpression(node)) {
      const converted = booleanConditional(node, sourceFile);
      if (converted) edits.push(converted);
    }
  }
  return edits;
}

// Keeps the earliest of overlapping edits.
function disjoint(edits, text) {
  const kept = [];
  for (const edit of [...edits].sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (editLines(edit, text) > maxEditLines) continue;
    if (kept.length && edit.start < kept.at(-1).end) continue;
    kept.push(edit);
  }
  return kept;
}

function buildBranchComplexity({ finding, node, sourceFile }) {
  const fn = flaggedFunction(node);
  if (!fn || !ts.isBlock(fn.body)) return;
  const edits = disjoint(rewrites(fn, sourceFile), sourceFile.text);
  if (!edits.length) return;
  const removed = edits.reduce((sum, edit) => sum + edit.removed, 0);
  const complexity = Number(/branch complexity of (\d+)/.exec(finding.message)?.[1]);
  const note = Number.isFinite(complexity)
    ? `Lowers the branch complexity from ${complexity} to ${complexity - removed}.` +
      (complexity - removed >= 15 ? ' Extract the remaining decisions into named functions by hand.' : '')
    : undefined;
  return { edits: edits.map(({ start, end, text }) => ({ start, end, text })), note };
}

module.exports = { 'high-branch-complexity': buildBranchComplexity };
