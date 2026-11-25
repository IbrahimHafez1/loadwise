// Auto-fix builder for sequential-http-in-loop. The payment idempotency key has no builder: the key
// must be a stable id of the order or attempt, which no rewrite can invent without defeating the
// purpose of the key.
import { requireReview, hasCommentBetween, ts } from './helpers.js';
import type { ForOfStatement, Node } from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.js';

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

export default {
  'sequential-http-in-loop': requireReview(
    'Confirm the requests are independent, their results are not collected in loop order, and the API tolerates concurrent calls.',
    sequentialHttpFix,
  ),
};
