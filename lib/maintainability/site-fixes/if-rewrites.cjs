'use strict';

// If-statement rewrites that remove one nesting level without changing what runs: a guard clause for an if that ends a function
// or loop body, merging an if whose only statement is another if, and dropping an else after a branch that exits.
const {
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
} = require('./helpers.cjs');

const jumpKinds = new Set([
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
]);

// A short jump that may be repeated earlier: the same target, and nothing runs in between.
const maxCopiedJumpLength = 60;

function copyableJump(statement, sourceFile, sameBlock) {
  if (!statement || !jumpKinds.has(statement.kind)) return;
  // A name or call copied across a lexical scope can observe a shadowed binding or run before a disposer.
  if (!sameBlock && statement.expression && !ts.isLiteralExpression(statement.expression)) return;
  const text = statement.getText(sourceFile);
  if (text.length <= maxCopiedJumpLength && !text.includes('\n')) return text.replace(/;$/, '');
}

// The exit that skips nothing when `statement` completes: `return` at the end of a function body, `continue` at the
// end of a loop body, or a copy of the jump that directly follows. Stay inside the same try/catch/finally
// region so evaluating a copied return keeps its exception handler and its order relative to cleanup.
function tailExit(statement, destinationBlock = statement.parent) {
  const sourceFile = statement.getSourceFile();
  let current = statement;
  for (;;) {
    const parent = current.parent;
    if (ts.isIterationStatement(parent, false) && parent.statement === current) return 'continue';
    if (ts.isIfStatement(parent) && parent.expression !== current) {
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
function scopeOwner(block) {
  const owner = block.parent;
  return functionWithBody(owner) || ts.isIterationStatement(owner, false) ? owner : block;
}

// `if (condition) {` with nothing but whitespace around the condition, so no comment is lost.
function cleanHeader(statement, sourceFile) {
  const text = sourceFile.text;
  const head = text.slice(statement.getStart(sourceFile), statement.expression.getStart(sourceFile));
  const tail = text.slice(statement.expression.end, statement.thenStatement.getStart(sourceFile));
  return /^if\s*\(\s*$/.test(head) && /^\s*\)\s*$/.test(tail);
}

function dropFinalBreak(text) {
  return text.replace(/\r?\n$/, '');
}

function endsWithJump(block) {
  const last = block.statements.at(-1);
  return last !== undefined && jumpKinds.has(last.kind);
}

// Every path through the statement jumps past the next sibling.
function alwaysExits(statement) {
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

// The end of the rewritten span. Once only `moved` falls into the jump right after `statement` and `moved` always
// exits, nothing reaches that jump any more, so the span takes it in and the rewrite drops it (lint rules such as
// no-unreachable reject it). Undefined when removing it would lose a comment.
function rewriteEnd(statement, moved) {
  const siblings = statement.parent.statements;
  const follower = siblings[siblings.indexOf(statement) + 1];
  if (!follower || !jumpKinds.has(follower.kind) || !alwaysExits(moved)) return statement.end;
  const sourceFile = statement.getSourceFile();
  if (!ownsLines(follower) || !blank(sourceFile.text.slice(statement.end, follower.getStart(sourceFile)))) return;
  return follower.end;
}

// `if (<negated condition>) rest` as one readable line, or undefined.
function negatedHeader(statement, sourceFile, indentation, rest) {
  const condition = singleLine(negateCondition(statement.expression, sourceFile), statement.expression);
  if (condition === undefined) return;
  const line = `${indentation}if (${condition}) ${rest}`;
  if (readableCondition(line, clauseCount(statement.expression))) return line;
}

// An unbraced loop keeps its own iterator bindings and its break/continue targets when lifted.
function liftedLoop(loop, indentation) {
  if (!ts.isIterationStatement(loop, false) || !ownsLines(loop) || hasMultilineLiteral(loop)) return;
  const text = loop.getSourceFile().text;
  const start = loop.getStart();
  const loopIndentation = indentationAt(text, start);
  if (!loopIndentation.startsWith(indentation) || loopIndentation === indentation) return;
  const step = loopIndentation.slice(indentation.length);
  const lines = dedentLines(text.slice(lineStart(text, start), loop.end), step);
  if (lines !== undefined) return { lines, step };
}

function canLiftBlock(block) {
  // Extending a using declaration's lifetime delays its cleanup past the enclosing branch.
  return (
    !block.statements.some(
      (statement) => ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Using,
    ) && canHoist(block.statements, scopeOwner(block.parent.parent), block)
  );
}

// if (a) { ...rest } at the end of a function or loop body  →  if (!a) return; ...rest
function guardClause(statement, sourceFile) {
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

// if (a) update(); else for (...) ... at the end of a loop becomes an early continue followed by the for.
function unwrapElseLoop(statement, sourceFile) {
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
function mergeNestedIf(statement, sourceFile) {
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

// The `} else {` line of an if whose branches are both blocks, or undefined when it holds anything else.
function elseLine(statement, sourceFile) {
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
function unwrapElse(statement, sourceFile) {
  const start = elseLine(statement, sourceFile);
  if (start === undefined || !ts.isBlock(statement.parent) || !ownsLines(statement)) return;
  const otherwise = statement.elseStatement;
  const exit = endsWithJump(statement.thenStatement) ? '' : tailExit(statement, statement.thenStatement);
  if (exit === undefined || hasMultilineLiteral(otherwise)) return;
  if (!canLiftBlock(otherwise)) return;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const body = blockBody(otherwise, indentation);
  const lines = body && dedentLines(body.lines, body.step);
  if (lines === undefined) return;
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
function invertWithElse(statement, sourceFile) {
  if (elseLine(statement, sourceFile) === undefined || !ts.isBlock(statement.parent) || !ownsLines(statement)) return;
  const { thenStatement: then, elseStatement: otherwise } = statement;
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

function editLines(edit, text) {
  return Math.max(text.slice(edit.start, edit.end).split('\n').length, edit.text.split('\n').length);
}

// Every rewrite of an if between `deepest` and its function that lifts `deepest` one level.
function nestingEdits(deepest, sourceFile) {
  const edits = [];
  for (let child = deepest, node = deepest.parent; node && !functionWithBody(node); child = node, node = node.parent) {
    if (!ts.isIfStatement(node)) continue;
    if (child === node.thenStatement) {
      edits.push(mergeNestedIf(node, sourceFile), guardClause(node, sourceFile), invertWithElse(node, sourceFile));
    } else if (child === node.elseStatement) edits.push(unwrapElse(node, sourceFile), unwrapElseLoop(node, sourceFile));
  }
  return edits.filter(Boolean);
}

// The smallest rewrite reads best and is the likeliest to fit an inline fix.
function smallest(edits, text) {
  let best;
  for (const edit of edits) if (!best || editLines(edit, text) < editLines(best, text)) best = edit;
  return best;
}

module.exports = { mergeNestedIf, nestingEdits, smallest, editLines, cleanHeader, jumpKinds };
