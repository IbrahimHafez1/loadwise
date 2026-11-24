// Shared by site fixes that move an awaited call out of an expression into a statement placed
// before it.
import { ts, textOf, lineStart } from './helpers.cjs';
import type { Node, Statement, SyntaxKind } from 'typescript';
import type { HoistAnchor } from '../types/hoist-anchor.cjs';

// Whether a node may be evaluated earlier than it is now because the caller hoists it too.
type FreeCheck = (node: Node) => boolean;

const neverFree: FreeCheck = () => false;
const clockCalls = new Set(['Date.now', 'performance.now']);
const unaryWrites = new Set<SyntaxKind>([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]);

// True when evaluating `node` has no effect another expression could observe, so its position among
// awaits is free.
const pureKeywordKinds: readonly SyntaxKind[] = [
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.SuperKeyword,
];

// loadwise-reviewed high-branch-complexity -- a flat dispatch over independent expression kinds, one early return per kind; each case is exclusive and a lookup table would hide the recursion
function isPure(node: Node | undefined, isFree: FreeCheck = neverFree): boolean {
  if (!node || isFree(node)) return true;
  if (ts.isIdentifier(node) || ts.isLiteralExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isFunctionLike(node) || ts.isRegularExpressionLiteral(node)) return true;
  if (pureKeywordKinds.includes(node.kind)) return true;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node))
    return isPure(node.expression, isFree);
  if (ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return isPure(node.expression, isFree);
  if (ts.isPropertyAccessExpression(node)) return isPure(node.expression, isFree);
  if (ts.isElementAccessExpression(node))
    return isPure(node.expression, isFree) && isPure(node.argumentExpression, isFree);
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => isPure(span.expression, isFree));
  if (ts.isPrefixUnaryExpression(node)) return !unaryWrites.has(node.operator) && isPure(node.operand, isFree);
  if (ts.isTypeOfExpression(node)) return isPure(node.expression, isFree);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return false;
    return isPure(node.left, isFree) && isPure(node.right, isFree);
  }
  if (ts.isConditionalExpression(node))
    return [node.condition, node.whenTrue, node.whenFalse].every((child) => isPure(child, isFree));
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((child) => isPure(child, isFree));
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return isPure(node.expression, isFree);
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((child) => isPure(child, isFree));
  if (ts.isPropertyAssignment(node)) return !ts.isComputedPropertyName(node.name) && isPure(node.initializer, isFree);
  if (ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) return true;
  if (ts.isCallExpression(node))
    return clockCalls.has(textOf(node.expression)) && node.arguments.every((child) => isPure(child, isFree));
  if (ts.isNewExpression(node)) {
    return textOf(node.expression) === 'Date' && (node.arguments ?? []).every((child) => isPure(child, isFree));
  }
  return false;
}

const sequentialBinaryOperators = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const transparentKinds: readonly ((node: Node) => boolean)[] = [
  ts.isParenthesizedExpression,
  ts.isAsExpression,
  ts.isNonNullExpression,
  ts.isSatisfiesExpression,
  ts.isTypeAssertionExpression,
  ts.isAwaitExpression,
  ts.isSpreadElement,
  ts.isSpreadAssignment,
  ts.isPropertyAssignment,
  ts.isVariableDeclaration,
  ts.isVariableStatement,
  ts.isReturnStatement,
  ts.isExpressionStatement,
  ts.isThrowStatement,
];

function isStatementList(node: Node): boolean {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node);
}

// Whether `parent` evaluates everything before `child` without effects, and always evaluates
// `child`.
function reachesChildPurely(parent: Node, child: Node, isFree: FreeCheck): boolean {
  if (transparentKinds.some((test) => test(parent))) return true;
  const before = (list: readonly Node[]): boolean =>
    list.slice(0, list.indexOf(child)).every((earlier) => isPure(earlier, isFree));
  if (ts.isVariableDeclarationList(parent)) {
    const declarationNodes: readonly Node[] = parent.declarations;
    return parent.declarations
      .slice(0, declarationNodes.indexOf(child))
      .every((declaration) => isPure(declaration.initializer, isFree));
  }
  if (ts.isObjectLiteralExpression(parent)) return before([...parent.properties]);
  if (ts.isArrayLiteralExpression(parent)) return before([...parent.elements]);
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    if (parent.expression === child) return true;
    if (ts.isCallExpression(parent) && parent.questionDotToken) return false;
    return isPure(parent.expression, isFree) && before([...(parent.arguments ?? [])]);
  }
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === child;
  if (ts.isElementAccessExpression(parent)) return parent.expression === child || isPure(parent.expression, isFree);
  if (ts.isBinaryExpression(parent)) {
    if (parent.left === child) return true;
    return !sequentialBinaryOperators.has(parent.operatorToken.kind) && isPure(parent.left, isFree);
  }
  if (ts.isConditionalExpression(parent)) return parent.condition === child;
  if (ts.isTemplateSpan(parent)) return true;
  if (ts.isTemplateExpression(parent)) {
    const spanNodes: readonly Node[] = parent.templateSpans;
    return parent.templateSpans.slice(0, spanNodes.indexOf(child)).every((span) => isPure(span.expression, isFree));
  }
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.expression === child;
  if (ts.isIfStatement(parent) || ts.isSwitchStatement(parent)) return parent.expression === child;
  return false;
}

// Where a hoisted line can go: before the statement that always runs `start`, or into a concise
// arrow body. Nodes accepted by `isFree` may be evaluated earlier than they are now (they are
// hoisted too).
function hoistAnchor(start: Node, isFree: FreeCheck = neverFree): HoistAnchor | undefined {
  let child = start;
  for (let parent: Node | undefined = start.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isStatement(child) && isStatementList(parent)) return { statement: child };
    if (ts.isArrowFunction(parent) && parent.body === child) return { arrow: parent };
    if (ts.isFunctionLike(parent) || isStatementList(parent)) return;
    if (!reachesChildPurely(parent, child, isFree)) return;
  }
}

function startsOwnLine(statement: Statement): boolean {
  const text = statement.getSourceFile().text;
  const start = statement.getStart();
  return /^[ \t]*$/.test(text.slice(lineStart(text, start), start));
}

export { isPure, hoistAnchor, startsOwnLine };
