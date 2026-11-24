// If-statement rewrites that remove one nesting level without changing what runs: a guard clause
// for an if that ends a function or loop body, merging an if whose only statement is another if,
// and dropping an else after a branch that exits.
import {
  ts,
  functionWithBody,
  lineStart,
  indentationAt,
  newlineOf,
  blank,
  ownsLines,
  hasMultilineLiteral,
  dedentLines,
  blockBody,
  logicalOperand,
  singleLine,
  negateCondition,
  clauseCount,
  readableCondition,
  canHoist,
} from './helpers.cjs';
import { originalProgram } from './isolated-program.cjs';
import type {
  Block,
  Expression,
  IfStatement,
  Node,
  PropertyAccessExpression,
  SourceFile,
  Statement,
  TypeChecker,
} from 'typescript';
import type { TextEdit } from '../../shared/types.cjs';
import type { JumpRemovingEdit } from '../types/site-fix-edits.cjs';

/** A loop moved out of a branch: its lines with one indentation step removed, and that step. */
interface LiftedLoop {
  lines: string;
  step: string;
}

const jumpKinds = new Set([
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
]);

// A short jump that may be repeated earlier: the same target, and nothing runs in between.
const maxCopiedJumpLength = 60;

function copyableJump(
  statement: Statement | undefined,
  sourceFile: SourceFile,
  sameBlock: boolean,
): string | undefined {
  if (!statement || !jumpKinds.has(statement.kind)) return;
  // A name or call copied across a lexical scope can observe a shadowed binding or run before a
  // disposer.
  if (
    !sameBlock &&
    (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) &&
    statement.expression &&
    !ts.isLiteralExpression(statement.expression)
  )
    return;
  const text = statement.getText(sourceFile);
  if (text.length <= maxCopiedJumpLength && !text.includes('\n')) return text.replace(/;$/, '');
}

// The exit that skips nothing when `statement` completes: `return` at the end of a function body,
// `continue` at the end of a loop body, or a copy of the jump that directly follows. Stay inside
// the same try/catch/finally region so evaluating a copied return keeps its exception handler and
// its order relative to cleanup.
function tailExit(statement: Statement, destinationBlock: Node = statement.parent): string | undefined {
  const sourceFile = statement.getSourceFile();
  let current = statement;
  for (;;) {
    const parent = current.parent;
    if (ts.isIterationStatement(parent, false) && parent.statement === current) return 'continue';
    const condition: Node = ts.isIfStatement(parent) ? parent.expression : parent;
    if (ts.isIfStatement(parent) && condition !== current) {
      current = parent;
      continue;
    }
    if (!ts.isBlock(parent)) return;
    const index = parent.statements.indexOf(current);
    if (index !== parent.statements.length - 1)
      return copyableJump(parent.statements[index + 1], sourceFile, parent === destinationBlock);
    const owner = parent.parent;
    if (functionWithBody(owner) && owner.body === parent) return 'return';
    if (ts.isIterationStatement(owner, false) && owner.statement === parent) return 'continue';
    if (ts.isIfStatement(owner)) current = owner;
    else if (ts.isBlock(owner)) current = parent;
    else return;
  }
}

// The scope that statements join when they move out of a block directly inside `block`.
function scopeOwner(block: Node): Node {
  const owner = block.parent;
  return functionWithBody(owner) || ts.isIterationStatement(owner, false) ? owner : block;
}

// `if (condition) {` with nothing but whitespace around the condition, so no comment is lost.
function cleanHeader(statement: IfStatement, sourceFile: SourceFile): boolean {
  const text = sourceFile.text;
  const head = text.slice(statement.getStart(sourceFile), statement.expression.getStart(sourceFile));
  const tail = text.slice(statement.expression.end, statement.thenStatement.getStart(sourceFile));
  return /^if\s*\(\s*$/.test(head) && /^\s*\)\s*$/.test(tail);
}

function dropFinalBreak(text: string) {
  return text.replace(/\r?\n$/, '');
}

function endsWithJump(block: Block): boolean {
  const last = block.statements.at(-1);
  return last !== undefined && jumpKinds.has(last.kind);
}

// Every path through the statement jumps past the next sibling.
function alwaysExits(statement: Statement): boolean {
  if (jumpKinds.has(statement.kind)) return true;
  if (ts.isBlock(statement)) return statement.statements.some(alwaysExits);
  if (ts.isTryStatement(statement)) {
    if (statement.finallyBlock && alwaysExits(statement.finallyBlock)) return true;
    return alwaysExits(statement.tryBlock) && (!statement.catchClause || alwaysExits(statement.catchClause.block));
  }
  return (
    ts.isIfStatement(statement) &&
    statement.elseStatement !== undefined &&
    alwaysExits(statement.thenStatement) &&
    alwaysExits(statement.elseStatement)
  );
}

// The end of the rewritten span. Once only `moved` falls into the jump right after `statement` and
// `moved` always exits, nothing reaches that jump any more, so the span takes it in and the rewrite
// drops it (lint rules such as no-unreachable reject it). Undefined when removing it would lose a
// comment.
function rewriteEnd(statement: Statement, moved: Statement): number | undefined {
  const parent = statement.parent;
  const siblings: readonly Statement[] = ts.isBlock(parent) ? parent.statements : [];
  const follower = siblings[siblings.indexOf(statement) + 1];
  if (!follower || !jumpKinds.has(follower.kind) || !alwaysExits(moved)) return statement.end;
  const sourceFile = statement.getSourceFile();
  if (!ownsLines(follower) || !blank(sourceFile.text.slice(statement.end, follower.getStart(sourceFile)))) return;
  return follower.end;
}

function withoutParentheses(expression: Expression) {
  let bare = expression;
  while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
  return bare;
}

function andOperands(expression: Expression): Expression[] {
  const bare = withoutParentheses(expression);
  if (ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return [...andOperands(bare.left), ...andOperands(bare.right)];
  return [bare];
}

// A `.length` read of a string or array, which is never negative or NaN.
function lengthRead(expression: Expression, checker: TypeChecker): PropertyAccessExpression | undefined {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'length') return;
  if (expression.questionDotToken) return;
  const receiver = checker.getNonNullableType(checker.getTypeAtLocation(expression.expression));
  // An unresolved import reads as `any`, which says nothing about what `.length` holds.
  if (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
  if (receiver.flags & ts.TypeFlags.StringLike || checker.isArrayLikeType(receiver)) return expression;
}

const nonEmptyTests = new Set([ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);

// `x.length`, `x.length > 0` or `x.length !== 0`: the access when it only tests for a non-empty
// string or array.
function nonEmptyTest(operand: Expression, checker: TypeChecker): PropertyAccessExpression | undefined {
  if (!ts.isBinaryExpression(operand)) return lengthRead(operand, checker);
  if (!nonEmptyTests.has(operand.operatorToken.kind) || operand.right.getText() !== '0') return;
  return lengthRead(operand.left, checker);
}

// A plain name or property path, read twice by the original guard without side effects.
function stableReference(expression: Expression): boolean {
  if (ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword) return true;
  return (
    ts.isPropertyAccessExpression(expression) && !expression.questionDotToken && stableReference(expression.expression)
  );
}

const comparisonFlips = new Map([
  [ts.SyntaxKind.GreaterThanToken, '<='],
  [ts.SyntaxKind.GreaterThanEqualsToken, '<'],
  [ts.SyntaxKind.LessThanToken, '>='],
  [ts.SyntaxKind.LessThanEqualsToken, '>'],
]);

// Neither side can be NaN, so `!(a > b)` and `a <= b` agree.
function neverNaN(expression: Expression, checker: TypeChecker): boolean {
  return ts.isNumericLiteral(expression) || lengthRead(expression, checker) !== undefined;
}

function flippedComparison(operand: Expression, sourceFile: SourceFile, checker: TypeChecker): string | undefined {
  if (!ts.isBinaryExpression(operand) || !comparisonFlips.has(operand.operatorToken.kind)) return;
  if (!lengthRead(operand.left, checker) && !lengthRead(operand.right, checker)) return;
  if (!neverNaN(operand.left, checker) || !neverNaN(operand.right, checker)) return;
  const flipped = comparisonFlips.get(operand.operatorToken.kind);
  return operand.left.getText(sourceFile) + ' ' + flipped + ' ' + operand.right.getText(sourceFile);
}

const logicalKinds = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

// Negates a plain `&&` chain over string or array lengths without a negated comparison: `x &&
// x.length > 0` becomes `!x?.length` and `x.length > 0` becomes `x.length <= 0`. Undefined when
// nothing reads better.
function negatedLengthTest(expression: Expression, sourceFile: SourceFile): string | undefined {
  const operands = andOperands(expression);
  if (operands.some((operand) => ts.isBinaryExpression(operand) && logicalKinds.has(operand.operatorToken.kind)))
    return;
  if (operands.some((operand) => ts.isPrefixUnaryExpression(operand))) return;
  const checker = originalProgram(sourceFile).getTypeChecker();
  const negated: string[] = [];
  let improved = false;
  for (let index = 0; index < operands.length; index++) {
    const operand = operands[index];
    const access = operands[index + 1] && nonEmptyTest(operands[index + 1], checker);
    if (access && stableReference(operand) && access.expression.getText(sourceFile) === operand.getText(sourceFile)) {
      negated.push('!' + operand.getText(sourceFile) + '?.length');
      improved = true;
      index++;
      continue;
    }
    const flipped = flippedComparison(operand, sourceFile, checker);
    if (flipped) improved = true;
    negated.push(flipped ?? negateCondition(operand, sourceFile));
  }
  return improved ? negated.join(' || ') : undefined;
}

// `if (<negated condition>) rest` as one readable line, or undefined.
function negatedHeader(
  statement: IfStatement,
  sourceFile: SourceFile,
  indentation: string,
  rest: string,
): string | undefined {
  const negated =
    negatedLengthTest(statement.expression, sourceFile) ?? negateCondition(statement.expression, sourceFile);
  const condition = singleLine(negated, statement.expression);
  if (condition === undefined) return;
  const line = `${indentation}if (${condition}) ${rest}`;
  if (readableCondition(line, clauseCount(statement.expression))) return line;
}

// An unbraced loop keeps its own iterator bindings and its break/continue targets when lifted.
function liftedLoop(loop: Statement, indentation: string): LiftedLoop | undefined {
  if (!ts.isIterationStatement(loop, false) || !ownsLines(loop) || hasMultilineLiteral(loop)) return;
  const text = loop.getSourceFile().text;
  const start = loop.getStart();
  const loopIndentation = indentationAt(text, start);
  if (!loopIndentation.startsWith(indentation) || loopIndentation === indentation) return;
  const step = loopIndentation.slice(indentation.length);
  const lines = dedentLines(text.slice(lineStart(text, start), loop.end), step);
  if (lines !== undefined) return { lines, step };
}

function canLiftBlock(block: Block): boolean {
  // Extending a using declaration's lifetime delays its cleanup past the enclosing branch.
  return (
    !block.statements.some(
      (statement: Statement) =>
        ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Using,
    ) && canHoist(block.statements, scopeOwner(block.parent.parent), block)
  );
}

// if (a) { ...rest } at the end of a function or loop body  →  if (!a) return; ...rest
function guardClause(statement: IfStatement, sourceFile: SourceFile): JumpRemovingEdit | undefined {
  const exit = tailExit(statement);
  const then = statement.thenStatement;
  if (!exit || statement.elseStatement || !ts.isBlock(statement.parent)) return;
  if (!ownsLines(statement) || !cleanHeader(statement, sourceFile) || hasMultilineLiteral(then)) return;
  const text = sourceFile.text;
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const guard = negatedHeader(statement, sourceFile, indentation, exit + ';');
  if (guard === undefined) return;
  if (!ts.isBlock(then)) {
    const loop = liftedLoop(then, indentation);
    if (loop)
      return {
        start: lineStart(text, statement.getStart()),
        end: statement.end,
        text: guard + newlineOf(text) + loop.lines,
      };
    return;
  }
  if (!canLiftBlock(then)) return;
  const body = blockBody(then, indentation);
  const lines = body && dedentLines(body.lines, body.step);
  if (lines === undefined) return;
  const end = rewriteEnd(statement, then);
  if (end === undefined) return;
  return {
    start: lineStart(text, statement.getStart(sourceFile)),
    end,
    removesTrailingJump: end > statement.end,
    text: guard + newlineOf(text) + dropFinalBreak(lines),
  };
}

// if (a) update(); else for (...) ... at the end of a loop becomes an early continue followed by
// the for.
function unwrapElseLoop(statement: IfStatement, sourceFile: SourceFile): TextEdit | undefined {
  const { thenStatement: then, elseStatement: otherwise } = statement;
  if (!otherwise || !ts.isIterationStatement(otherwise, false) || !ts.isBlock(statement.parent)) return;
  if (!ownsLines(statement) || !cleanHeader(statement, sourceFile)) return;
  const text = sourceFile.text;
  if (!/^\s*else\s*$/.test(text.slice(then.end, otherwise.getStart()))) return;
  const start = statement.getStart();
  const indentation = indentationAt(text, start);
  const loop = liftedLoop(otherwise, indentation);
  if (!loop || text.slice(start, then.end).includes('\n')) return;
  const newline = newlineOf(text);
  let branch = text.slice(start, then.end);
  if (!jumpKinds.has(then.kind)) {
    const exit = tailExit(statement);
    if (!ts.isExpressionStatement(then) || (exit !== 'continue' && exit !== 'return')) return;
    const bodyIndentation = indentation + loop.step;
    branch =
      text.slice(start, then.getStart()).trimEnd() +
      ' {' +
      newline +
      bodyIndentation +
      then.getText() +
      newline +
      bodyIndentation +
      exit +
      ';' +
      newline +
      indentation +
      '}';
  }
  return { start, end: statement.end, text: branch + newline + loop.lines };
}

// if (a) { if (b) { ... } }  →  if (a && b) { ... }
function mergeNestedIf(statement: IfStatement, sourceFile: SourceFile): TextEdit | undefined {
  const then = statement.thenStatement;
  if (statement.elseStatement || !ts.isBlock(then) || then.statements.length !== 1) return;
  const inner = then.statements[0];
  if (!ts.isIfStatement(inner) || inner.elseStatement) return;
  if (!ownsLines(statement) || !ownsLines(inner) || !cleanHeader(statement, sourceFile)) return;
  if (!cleanHeader(inner, sourceFile) || hasMultilineLiteral(inner)) return;
  const text = sourceFile.text;
  // Comments around the inner if would be lost.
  if (!blank(text.slice(then.getStart(sourceFile) + 1, inner.getStart(sourceFile)))) return;
  if (!blank(text.slice(inner.end, then.end - 1))) return;
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const innerIndentation = indentationAt(text, inner.getStart(sourceFile));
  const step = innerIndentation.slice(indentation.length);
  if (!step || !innerIndentation.startsWith(indentation)) return;
  const outerCondition = singleLine(logicalOperand(statement.expression, sourceFile), statement.expression);
  const innerCondition = singleLine(logicalOperand(inner.expression, sourceFile), inner.expression);
  if (outerCondition === undefined || innerCondition === undefined) return;
  const condition = outerCondition + ' && ' + innerCondition;
  const start = lineStart(text, statement.getStart(sourceFile));
  const innerThen = inner.thenStatement;
  const header = `${indentation}if (${condition}) `;
  const clauses = clauseCount(statement.expression) + clauseCount(inner.expression);
  if (!ts.isBlock(innerThen)) {
    const single = innerThen.getText(sourceFile);
    if (single.includes('\n') || !readableCondition(header + single, clauses)) return;
    return { start, end: statement.end, text: header + single };
  }
  if (!readableCondition(header + '{', clauses)) return;
  const body = blockBody(innerThen, innerIndentation);
  if (!body) return;
  const lines = dedentLines(body.lines, step);
  if (lines === undefined) return;
  return {
    start,
    end: statement.end,
    text: `${indentation}if (${condition}) {${newlineOf(text)}${lines}${indentation}}`,
  };
}

// The `} else {` line of an if whose branches are both blocks, or undefined when it holds anything
// else.
function elseLine(statement: IfStatement, sourceFile: SourceFile): number | undefined {
  const { thenStatement: then, elseStatement: otherwise } = statement;
  if (!otherwise || !ts.isBlock(then) || !ts.isBlock(otherwise)) return;
  const text = sourceFile.text;
  const close = then.end - 1;
  if (!blank(text.slice(lineStart(text, close), close))) return;
  if (!/^[ \t]*else[ \t]*$/.test(text.slice(then.end, otherwise.getStart(sourceFile)))) return;
  return lineStart(text, close);
}

// if (a) { ...; return; } else { ...rest }  →  if (a) { ...; return; } ...rest
// At the end of a function or loop body the exit is added to the first branch.
function unwrapElse(statement: IfStatement, sourceFile: SourceFile): JumpRemovingEdit | undefined {
  const start = elseLine(statement, sourceFile);
  if (start === undefined || !ts.isBlock(statement.parent) || !ownsLines(statement)) return;
  const { thenStatement: then, elseStatement: otherwise } = statement;
  if (!ts.isBlock(then) || !otherwise || !ts.isBlock(otherwise)) return;
  const exit = endsWithJump(then) ? '' : tailExit(statement, then);
  if (exit === undefined || hasMultilineLiteral(otherwise)) return;
  if (!canLiftBlock(otherwise)) return;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const body = blockBody(otherwise, indentation);
  const lines = body && dedentLines(body.lines, body.step);
  if (!body || lines === undefined) return;
  const added = exit ? indentation + body.step + exit + ';' + newline : '';
  const end = exit ? rewriteEnd(statement, otherwise) : statement.end;
  if (end === undefined) return;
  return {
    start,
    end,
    removesTrailingJump: end > statement.end,
    text: added + indentation + '}' + newline + dropFinalBreak(lines),
  };
}

// if (a) { ...nested } else { ...other }  →  if (!a) { ...other; return; } ...nested
// Only at the end of a function or loop body, where the added exit skips nothing.
function invertWithElse(statement: IfStatement, sourceFile: SourceFile): JumpRemovingEdit | undefined {
  if (elseLine(statement, sourceFile) === undefined || !ts.isBlock(statement.parent) || !ownsLines(statement)) return;
  const { thenStatement: then, elseStatement: otherwise } = statement;
  if (!ts.isBlock(then) || !otherwise || !ts.isBlock(otherwise)) return;
  const exit = tailExit(statement, otherwise);
  if (!exit || !cleanHeader(statement, sourceFile) || hasMultilineLiteral(then)) return;
  if (!canLiftBlock(then)) return;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const thenBody = blockBody(then, indentation);
  const otherBody = blockBody(otherwise, indentation);
  const lines = thenBody && dedentLines(thenBody.lines, thenBody.step);
  if (lines === undefined || !otherBody) return;
  const added = endsWithJump(otherwise) ? '' : indentation + otherBody.step + exit + ';' + newline;
  const header = negatedHeader(statement, sourceFile, indentation, '{');
  const end = added ? rewriteEnd(statement, then) : statement.end;
  if (header === undefined || end === undefined) return;
  return {
    start: lineStart(text, statement.getStart(sourceFile)),
    end,
    removesTrailingJump: end > statement.end,
    text: header + newline + otherBody.lines + added + indentation + '}' + newline + dropFinalBreak(lines),
  };
}

function editLines(edit: TextEdit, text: string): number {
  return Math.max(text.slice(edit.start, edit.end).split('\n').length, edit.text.split('\n').length);
}

// Every rewrite of an if between `deepest` and its function that lifts `deepest` one level.
function nestingEdits(deepest: Node, sourceFile: SourceFile): JumpRemovingEdit[] {
  const edits: (JumpRemovingEdit | undefined)[] = [];
  for (
    let child: Node = deepest, node: Node | undefined = deepest.parent;
    node && !functionWithBody(node);
    child = node, node = node.parent
  ) {
    if (!ts.isIfStatement(node)) continue;
    if (child === node.thenStatement) {
      edits.push(mergeNestedIf(node, sourceFile), guardClause(node, sourceFile), invertWithElse(node, sourceFile));
    } else if (child === node.elseStatement) edits.push(unwrapElse(node, sourceFile), unwrapElseLoop(node, sourceFile));
  }
  return edits.filter((edit): edit is JumpRemovingEdit => edit !== undefined);
}

// The smallest rewrite reads best and is the likeliest to fit an inline fix.
function smallest<Edit extends TextEdit>(edits: readonly Edit[], text: string): Edit | undefined {
  let best: Edit | undefined;
  for (const edit of edits) if (!best || editLines(edit, text) < editLines(best, text)) best = edit;
  return best;
}

export { mergeNestedIf, nestingEdits, smallest, editLines, cleanHeader, jumpKinds };
