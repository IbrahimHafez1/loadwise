import { ts } from '../../performance/compiler.js';
import { isAccess, isAssignmentOperator } from '../source-helpers.js';
import type { AccessExpression } from '../source-helpers.js';
import type { Node } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

const note =
  'The read now yields undefined instead of throwing when the value is missing, and that undefined flows on to the caller. ' +
  'Add a `?? default` where a value is needed, or answer with a 400 when the input is required.';

// The finding points at the property name (or the bracket argument) of the read.
function reportedAccess(node: Node): AccessExpression | undefined {
  return ts.findAncestor(node, (candidate): candidate is AccessExpression => {
    if (ts.isPropertyAccessExpression(candidate)) return candidate.name === node;
    return (
      ts.isElementAccessExpression(candidate) &&
      ts.findAncestor(node, (inner) => inner === candidate.argumentExpression) !== undefined
    );
  });
}

// Whether `parent` is a step on the way from a destructuring target up to the pattern that holds it.
function isPatternStep(parent: Node, child: Node): boolean {
  return (
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === child)
  );
}

// `[req.body.a.b] = list`, `({ key: req.body.a.b } = source)` and `({ ...req.body.a.b } = source)` write to
// the access although it sits inside an array or object literal.
function isDestructuringTarget(node: Node): boolean {
  let current = node;
  let insideLiteral = false;
  while (isPatternStep(current.parent, current)) {
    current = current.parent;
    if (ts.isArrayLiteralExpression(current) || ts.isObjectLiteralExpression(current)) insideLiteral = true;
  }
  if (!insideLiteral) return false;
  const parent = current.parent;
  if (ts.isBinaryExpression(parent))
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === current;
  return (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === current;
}

// `?.` cannot start an assignment, `delete` or `++` target, or a tagged template tag.
function endsInWriteTarget(access: AccessExpression): boolean {
  let top: Node = access;
  while (
    (isAccess(top.parent) && top.parent.expression === top) ||
    (ts.isCallExpression(top.parent) && top.parent.expression === top) ||
    ts.isNonNullExpression(top.parent) ||
    ts.isParenthesizedExpression(top.parent)
  )
    top = top.parent;
  if (isDestructuringTarget(top)) return true;
  const parent = top.parent;
  if (ts.isTaggedTemplateExpression(parent)) return parent.tag === top;
  if (ts.isDeleteExpression(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return true;
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  return ts.isBinaryExpression(parent) && parent.left === top && isAssignmentOperator(parent.operatorToken.kind);
}

function optionalAccessFix({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const access = reportedAccess(node);
  if (!access || access.questionDotToken || endsInWriteTarget(access)) return;
  const isProperty = ts.isPropertyAccessExpression(access);
  const operatorEnd = isProperty ? access.name.getStart() : access.argumentExpression.getStart();
  const gap = text.slice(access.expression.end, operatorEnd);
  const operator = isProperty ? '.' : '[';
  const offset = gap.lastIndexOf(operator);
  if (offset < 0) return;
  const start = access.expression.end + offset;
  return {
    edits: [{ start, end: start + 1, text: isProperty ? '?.' : '?.[' }],
    note,
    requiresReview: true,
  };
}

const builders: Record<string, SiteFixBuilder> = { 'unguarded-boundary-access': optionalAccessFix };

export default builders;
