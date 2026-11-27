// Auto-fix builder for sequential-http-in-loop. The payment idempotency key has no builder: the key
// must be a stable id of the order or attempt, which no rewrite can invent without defeating the
// purpose of the key.
import { requireReview, hasCommentBetween, ts, indentationAt, lineStart } from './helpers.js';
import type { ForOfStatement, Node } from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

function isLoop(node: Node): boolean {
  return ts.isForOfStatement(node) || ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

function nearestLoop(node: Node): Node | undefined {
  for (let current = node.parent; current && !ts.isFunctionLike(current); current = current.parent) {
    if (isLoop(current)) return current;
  }
}

// Control flow that `Promise.all` cannot carry out of the per-item callback.
function escapesIteration(node: Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) return true;
  if (ts.isYieldExpression(node)) return true;
  return !!ts.forEachChild(node, (child) => escapesIteration(child) || undefined);
}

function isPlainConstItem(loop: ForOfStatement): boolean {
  if (!ts.isVariableDeclarationList(loop.initializer)) return false;
  const [declaration] = loop.initializer.declarations;
  return Boolean(loop.initializer.flags & ts.NodeFlags.Const) && ts.isIdentifier(declaration.name);
}

// Rewrites `for (const item of items) { await fetch(...); }` into `await
// Promise.all(Array.from(items).map(...))`.
// `Array.from` keeps the rewrite valid for any iterable the loop could walk, not only arrays.
function sequentialHttpFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const loop = nearestLoop(node);
  if (!loop || !ts.isForOfStatement(loop) || loop.awaitModifier || !isPlainConstItem(loop)) return;
  if (!ts.isBlock(loop.statement) || escapesIteration(loop.statement)) return;
  if (hasCommentBetween(sourceFile.text, loop.getStart(sourceFile), loop.end)) return;
  if (!ts.isVariableDeclarationList(loop.initializer)) return;
  const itemName = loop.initializer.declarations[0].name.getText(sourceFile);
  const collection = loop.expression.getText(sourceFile);
  const body = loop.statement.getText(sourceFile);
  return {
    edits: [
      {
        start: loop.getStart(sourceFile),
        end: loop.end,
        text: `await Promise.all(Array.from(${collection}).map(async (${itemName}) => ${body}));`,
      },
    ],
    note: 'Runs every request at once with Promise.all. For large lists wrap the callback in a bounded pool such as p-limit.',
  };
}

function expressMissingCompressionFix({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const listenCall = ts.findAncestor(
    node,
    (candidate) =>
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      candidate.expression.name.text === 'listen',
  );
  if (!listenCall || !ts.isCallExpression(listenCall) || !ts.isPropertyAccessExpression(listenCall.expression)) return;
  const appText = listenCall.expression.expression.getText(sourceFile);
  const stmt = ts.findAncestor(listenCall, ts.isStatement);
  if (!stmt) return;
  const at = lineStart(text, stmt.getStart(sourceFile));
  const indent = indentationAt(text, stmt.getStart(sourceFile));
  const edits: TextEdit[] = [{ start: at, end: at, text: `${indent}${appText}.use(compression());\n` }];
  if (!/\bcompression\b/.test(text)) {
    const imports = sourceFile.statements.filter(ts.isImportDeclaration);
    const importPos = imports.length ? imports[imports.length - 1].end : 0;
    const importText = imports.length
      ? "\nimport compression from 'compression';"
      : "import compression from 'compression';\n";
    edits.push({ start: importPos, end: importPos, text: importText });
  }
  return {
    edits,
    note: 'Adds `compression()` middleware before `listen()`; verify `compression` is installed and not already handled by a reverse proxy.',
  };
}

export default {
  'sequential-http-in-loop': requireReview(
    'Confirm the requests are independent, their results are not collected in loop order, and the API tolerates concurrent calls.',
    sequentialHttpFix,
  ),
  'express-missing-compression': requireReview(
    'Ensure `compression` is installed (`npm i compression`) and not duplicated behind a compressing reverse proxy.',
    expressMissingCompressionFix,
  ),
};
