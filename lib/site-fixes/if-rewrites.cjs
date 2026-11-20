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

function copyableJump(statement, sourceFile) {
  if (!statement || !jumpKinds.has(statement.kind)) return;
  const text = statement.getText(sourceFile);
  if (text.length <= maxCopiedJumpLength && !text.includes('\n')) return text.replace(/;$/, '');
}

// The exit that skips nothing when `statement` completes: `return` at the end of a function body, `continue` at the
// end of a loop body, or a copy of the jump that directly follows. Finally blocks are excluded: a jump there
// would swallow exceptions.
function tailExit(statement) {
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
    if (index !== parent.statements.length - 1) return copyableJump(parent.statements[index + 1], sourceFile);
    const owner = parent.parent;
    if (functionWithBody(owner) && owner.body === parent) return 'return';
    if (ts.isIterationStatement(owner, false) && owner.statement === parent) return 'continue';
    if (ts.isIfStatement(owner)) current = owner;
    else if (ts.isBlock(owner)) current = parent;
    else if (ts.isTryStatement(owner) && owner.tryBlock === parent) current = owner;
    else if (ts.isCatchClause(owner)) current = owner.parent;
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

// if (a) { ...rest } at the end of a function or loop body  →  if (!a) return; ...rest
function guardClause(statement, sourceFile) {
  const exit = tailExit(statement);
  const then = statement.thenStatement;
  if (!exit || statement.elseStatement || !ts.isBlock(then) || !ts.isBlock(statement.parent)) return;
  if (!ownsLines(statement) || !cleanHeader(statement, sourceFile) || hasMultilineLiteral(then)) return;
  if (!canHoist(then.statements, scopeOwner(statement.parent), statement)) return;
  const text = sourceFile.text;
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const body = blockBody(then, indentation);
  const lines = body && dedentLines(body.lines, body.step);
  if (lines === undefined) return;
  const guard = `${indentation}if (${negateCondition(statement.expression, sourceFile)}) ${exit};`;
  return {
    start: lineStart(text, statement.getStart(sourceFile)),
    end: statement.end,
    text: guard + newlineOf(text) + dropFinalBreak(lines),
  };
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
  if (!ts.isBlock(innerThen)) {
    const single = innerThen.getText(sourceFile);
    if (single.includes('\n')) return;
    return { start, end: statement.end, text: `${indentation}if (${condition}) ${single}` };
  }
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
  const exit = endsWithJump(statement.thenStatement) ? '' : tailExit(statement);
  if (exit === undefined || hasMultilineLiteral(otherwise)) return;
  if (!canHoist(otherwise.statements, scopeOwner(statement.parent), statement)) return;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const body = blockBody(otherwise, indentation);
  const lines = body && dedentLines(body.lines, body.step);
  if (lines === undefined) return;
  const added = exit ? indentation + body.step + exit + ';' + newline : '';
  return {
    start,
    end: statement.end,
    text: added + indentation + '}' + newline + dropFinalBreak(lines),
  };
}

// if (a) { ...nested } else { ...other }  →  if (!a) { ...other; return; } ...nested
// Only at the end of a function or loop body, where the added exit skips nothing.
function invertWithElse(statement, sourceFile) {
  if (elseLine(statement, sourceFile) === undefined || !ts.isBlock(statement.parent) || !ownsLines(statement)) return;
  const { thenStatement: then, elseStatement: otherwise } = statement;
  const exit = tailExit(statement);
  if (!exit || !cleanHeader(statement, sourceFile) || hasMultilineLiteral(then)) return;
  if (!canHoist(then.statements, scopeOwner(statement.parent), statement)) return;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const thenBody = blockBody(then, indentation);
  const otherBody = blockBody(otherwise, indentation);
  const lines = thenBody && dedentLines(thenBody.lines, thenBody.step);
  if (lines === undefined || !otherBody) return;
  const added = endsWithJump(otherwise) ? '' : indentation + otherBody.step + exit + ';' + newline;
  return {
    start: lineStart(text, statement.getStart(sourceFile)),
    end: statement.end,
    text:
      `${indentation}if (${negateCondition(statement.expression, sourceFile)}) {${newline}` +
      otherBody.lines +
      added +
      indentation +
      '}' +
      newline +
      dropFinalBreak(lines),
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
    } else if (child === node.elseStatement) edits.push(unwrapElse(node, sourceFile));
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
