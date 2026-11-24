// Site fixes for filter-for-existence and numeric-sort-for-extreme, which replace a full filter or
// sort with some() or one reduce() pass.
import { ts, calleeCall } from './helpers.cjs';
import type { BinaryExpression, CallExpression, Node, PropertyAccessExpression, SyntaxKind } from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';
import { skipParentheses, outerParenthesized } from './collection-helpers.cjs';

interface ExistenceRewrite {
  replaced: Node;
  negate: boolean;
}

interface ExtremeEnd {
  value: Node;
  last: boolean;
}

// Whether `length <op> threshold` (or the mirrored form) holds exactly when the array is non-empty
// (true), exactly when it is empty (false), or neither (undefined).
function lengthComparisonPositive(kind: SyntaxKind, threshold: number, lengthOnLeft: boolean): boolean | undefined {
  if (threshold === 0) {
    const zeroTable: Record<number, boolean | undefined> = {
      [ts.SyntaxKind.ExclamationEqualsEqualsToken]: true,
      [ts.SyntaxKind.ExclamationEqualsToken]: true,
      [ts.SyntaxKind.EqualsEqualsEqualsToken]: false,
      [ts.SyntaxKind.EqualsEqualsToken]: false,
      [ts.SyntaxKind.GreaterThanToken]: lengthOnLeft ? true : undefined,
      [ts.SyntaxKind.LessThanToken]: lengthOnLeft ? undefined : true,
      [ts.SyntaxKind.LessThanEqualsToken]: lengthOnLeft ? false : undefined,
      [ts.SyntaxKind.GreaterThanEqualsToken]: lengthOnLeft ? undefined : false,
    };
    return zeroTable[kind];
  }
  if (threshold === 1) {
    const oneTable: Record<number, boolean | undefined> = {
      [ts.SyntaxKind.GreaterThanEqualsToken]: lengthOnLeft ? true : undefined,
      [ts.SyntaxKind.LessThanEqualsToken]: lengthOnLeft ? undefined : true,
      [ts.SyntaxKind.LessThanToken]: lengthOnLeft ? false : undefined,
      [ts.SyntaxKind.GreaterThanToken]: lengthOnLeft ? undefined : false,
    };
    return oneTable[kind];
  }
  return undefined;
}

function comparisonExistenceRewrite(
  length: PropertyAccessExpression,
  comparison: BinaryExpression,
): ExistenceRewrite | undefined {
  const lengthOnLeft = comparison.left === length;
  const other = lengthOnLeft ? comparison.right : comparison.left;
  if (!ts.isNumericLiteral(other)) return;
  const positive = lengthComparisonPositive(comparison.operatorToken.kind, Number(other.text), lengthOnLeft);
  if (positive === undefined) return;
  return { replaced: comparison, negate: !positive };
}

function isLogicalOperation(node: Node): boolean {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  );
}

function isStatementCondition(consumer: Node, expression: Node): boolean {
  return (
    ((ts.isIfStatement(consumer) || ts.isWhileStatement(consumer) || ts.isDoStatement(consumer)) &&
      consumer.expression === expression) ||
    ((ts.isConditionalExpression(consumer) || ts.isForStatement(consumer)) && consumer.condition === expression)
  );
}

// The rule only reports `Boolean(...)` after resolving it to the built-in conversion.
function isBooleanConversionArgument(consumer: Node, expression: Node): boolean {
  return (
    ts.isCallExpression(consumer) &&
    consumer.arguments.length === 1 &&
    consumer.arguments[0] === expression &&
    ts.isIdentifier(consumer.expression) &&
    consumer.expression.text === 'Boolean'
  );
}

function existenceRewrite(length: PropertyAccessExpression): ExistenceRewrite | undefined {
  const parent = length.parent;
  if (ts.isBinaryExpression(parent)) return comparisonExistenceRewrite(length, parent);
  let expression: Node = length;
  while (isLogicalOperation(expression.parent)) expression = expression.parent;
  const consumer = expression.parent;
  const inCondition =
    isStatementCondition(consumer, expression) ||
    (ts.isPrefixUnaryExpression(consumer) && consumer.operator === ts.SyntaxKind.ExclamationToken) ||
    isBooleanConversionArgument(consumer, expression);
  return inCondition ? { replaced: length, negate: false } : undefined;
}

export function filterExistenceFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'filter') return;
  if (call.arguments.length !== 1 || ts.isOptionalChain(call)) return;
  const length = call.parent;
  if (!ts.isPropertyAccessExpression(length) || length.expression !== call || length.name.text !== 'length') return;
  if (length.questionDotToken) return;
  const rewrite = existenceRewrite(length);
  if (!rewrite) return;
  const { replaced, negate } = rewrite;
  const edits: TextEdit[] = [{ start: call.expression.name.getStart(), end: call.expression.name.end, text: 'some' }];
  if (replaced === length) edits.push({ start: call.end, end: length.end, text: '' });
  else {
    edits.push({ start: replaced.getStart(), end: length.getStart(), text: negate ? '!' : '' });
    edits.push({ start: call.end, end: replaced.end, text: '' });
  }
  return {
    edits,
    note: 'some() stops at the first match, so the predicate must not rely on running for every element.',
  };
}

function comparatorDirection(compare: Node): { ascending: boolean } | undefined {
  const callback = skipParentheses(compare);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  if (callback.parameters.length !== 2) return;
  const [first, second] = callback.parameters;
  if (!ts.isIdentifier(first.name) || !ts.isIdentifier(second.name)) return;
  let body: Node | undefined = callback.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return;
    body = body.statements[0].expression;
    if (!body) return;
  }
  const result = skipParentheses(body);
  if (!ts.isBinaryExpression(result) || result.operatorToken.kind !== ts.SyntaxKind.MinusToken) return;
  const left = skipParentheses(result.left);
  const right = skipParentheses(result.right);
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text === right.text) return;
  if (left.text === first.name.text && right.text === second.name.text) return { ascending: true };
  if (left.text === second.name.text && right.text === first.name.text) return { ascending: false };
}

function sortedArraySource(method: string, receiver: Node): Node | undefined {
  if (method === 'toSorted') return receiver;
  if (ts.isArrayLiteralExpression(receiver) && receiver.elements.length === 1) {
    const [only] = receiver.elements;
    return ts.isSpreadElement(only) ? skipParentheses(only.expression) : undefined;
  }
  if (
    ts.isCallExpression(receiver) &&
    receiver.arguments.length === 1 &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === 'from' &&
    ts.isIdentifier(receiver.expression.expression) &&
    receiver.expression.expression.text === 'Array'
  )
    return skipParentheses(receiver.arguments[0]);
}

// The element access or `.at()` call that reads one end of the sorted copy.
function readEnd(sortCall: CallExpression): ExtremeEnd | undefined {
  const sorted = outerParenthesized(sortCall);
  const access = sorted.parent;
  if (ts.isElementAccessExpression(access) && access.expression === sorted && !access.questionDotToken) {
    const index = skipParentheses(access.argumentExpression);
    return ts.isNumericLiteral(index) && Number(index.text) === 0 ? { value: access, last: false } : undefined;
  }
  if (!ts.isPropertyAccessExpression(access) || access.expression !== sorted || access.name.text !== 'at') return;
  const lookup = access.parent;
  if (!ts.isCallExpression(lookup) || lookup.expression !== access || lookup.arguments.length !== 1) return;
  const index = skipParentheses(lookup.arguments[0]);
  if (ts.isNumericLiteral(index) && Number(index.text) === 0) return { value: lookup, last: false };
  if (
    ts.isPrefixUnaryExpression(index) &&
    index.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(index.operand) &&
    Number(index.operand.text) === 1
  )
    return { value: lookup, last: true };
}

export function sortExtremeFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) return;
  const method = call.expression.name.text;
  if (method !== 'sort' && method !== 'toSorted') return;
  const source = sortedArraySource(method, skipParentheses(call.expression.expression));
  if (!source || !ts.isIdentifier(source)) return;
  const order = comparatorDirection(call.arguments[0]);
  const end = readEnd(call);
  if (!order || !end) return;
  const wantsMinimum = order.ascending !== end.last;
  // A tie keeps the element the stable sort would have put at that end: the first one for index 0,
  // the last for -1.
  const comparison = (wantsMinimum ? '<' : '>') + (end.last ? '=' : '');
  const best = wantsMinimum ? 'min' : 'max';
  const array = source.text;
  return {
    edits: [
      {
        start: end.value.getStart(),
        end: end.value.end,
        text: `${array}.reduce((${best}, value) => (value ${comparison} ${best} ? value : ${best}), ${array}[0])`,
      },
    ],
    note: 'One pass, no copy and no spread limit; an empty array still gives undefined. Like the sort, this assumes plain numbers without NaN or holes.',
  };
}
