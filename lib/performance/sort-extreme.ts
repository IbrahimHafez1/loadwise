import { ts, isDefaultLibrary } from './compiler.js';
import { isStandardArrayCall, outerExpression, standardInterface } from './repeated.js';
import type {
  ArrowFunction,
  CallExpression,
  ConciseBody,
  ElementAccessExpression,
  Expression,
  FunctionExpression,
  Node,
  ParameterDeclaration,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, TypeAdapter } from '../shared/types.js';

/** The one element a sorted array is read for: `sorted[0]`, `.at(0)` or `.at(-1)`. */
interface SortEndpoint {
  value: ElementAccessExpression | CallExpression;
  last: boolean;
}

/**
 * A comparator of two plain parameters that returns `first - second` (ascending) or `second -
 * first`.
 */
interface ComparisonDirection {
  ascending: boolean;
  callback: FunctionExpression | ArrowFunction;
}

function observedValue(node: Node): boolean {
  const value = outerExpression(node);
  const use = value.parent;
  if (ts.isReturnStatement(use)) return use.expression === value;
  if (ts.isArrowFunction(use)) return use.body === value;
  if (ts.isVariableDeclaration(use) || ts.isPropertyAssignment(use)) return use.initializer === value;
  if (ts.isCallExpression(use)) return use.arguments.some((argument) => argument === value);
  if (ts.isBinaryExpression(use)) {
    if (use.operatorToken.kind === ts.SyntaxKind.EqualsToken) return use.right === value;
    if (use.operatorToken.kind === ts.SyntaxKind.CommaToken && use.left === value) return false;
    return !ts.isAssignmentOperator(use.operatorToken.kind) && observedValue(use);
  }
  return false;
}

function usedEndpoint(call: CallExpression): SortEndpoint | undefined {
  const sorted = outerExpression(call);
  const access = sorted.parent;
  if (!ts.isElementAccessExpression(access) && !ts.isPropertyAccessExpression(access)) return;
  if (access.expression !== sorted || ts.isOptionalChain(access)) return;
  if (
    ts.isElementAccessExpression(access) &&
    ts.isNumericLiteral(access.argumentExpression) &&
    Number(access.argumentExpression.text) === 0 &&
    observedValue(access)
  )
    return { value: access, last: false };
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'at') return;
  const lookup = access.parent;
  if (
    !ts.isCallExpression(lookup) ||
    lookup.expression !== access ||
    ts.isOptionalChain(lookup) ||
    lookup.arguments.length !== 1 ||
    !observedValue(lookup)
  )
    return;
  const index = ts.skipOuterExpressions(lookup.arguments[0]);
  if (ts.isNumericLiteral(index) && Number(index.text) === 0) return { value: lookup, last: false };
  if (
    ts.isPrefixUnaryExpression(index) &&
    index.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(index.operand) &&
    Number(index.operand.text) === 1
  )
    return { value: lookup, last: true };
}

function comparisonDirection(compare: Expression): ComparisonDirection | undefined {
  const callback = ts.skipOuterExpressions(compare);
  if (
    (!ts.isFunctionExpression(callback) && !ts.isArrowFunction(callback)) ||
    callback.asteriskToken ||
    ts.getCombinedModifierFlags(callback) & ts.ModifierFlags.Async ||
    callback.parameters.length !== 2 ||
    callback.parameters.some(
      (parameter: ParameterDeclaration) =>
        !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken,
    )
  )
    return;
  let body: ConciseBody | undefined = callback.body;
  if (ts.isBlock(body)) {
    const [onlyStatement] = body.statements;
    if (body.statements.length !== 1 || !ts.isReturnStatement(onlyStatement)) return;
    body = onlyStatement.expression;
    if (!body) return;
  }
  const result = ts.skipOuterExpressions(body);
  if (!ts.isBinaryExpression(result) || result.operatorToken.kind !== ts.SyntaxKind.MinusToken) return;
  const left = ts.skipOuterExpressions(result.left);
  const right = ts.skipOuterExpressions(result.right);
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text === right.text) return;
  const [first, second] = callback.parameters;
  if (!ts.isIdentifier(first.name) || !ts.isIdentifier(second.name)) return;
  if (left.text === first.name.text && right.text === second.name.text) return { ascending: true, callback };
  if (left.text === second.name.text && right.text === first.name.text) return { ascending: false, callback };
}

function privateCopySource(receiver: Expression, checker: CheckerAdapter): Expression | undefined {
  if (ts.isArrayLiteralExpression(receiver)) {
    const [onlyElement] = receiver.elements;
    if (receiver.elements.length === 1 && ts.isSpreadElement(onlyElement)) {
      return ts.skipOuterExpressions(onlyElement.expression);
    }
  }
  if (
    ts.isCallExpression(receiver) &&
    receiver.arguments.length === 1 &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === 'from' &&
    ts.isIdentifier(receiver.expression.expression) &&
    receiver.expression.expression.text === 'Array' &&
    standardInterface(receiver, checker) === 'ArrayConstructor'
  ) {
    const constructor = checker.getSymbolAtLocation(receiver.expression.expression)?.valueDeclaration;
    if (constructor && isDefaultLibrary(checker, constructor.getSourceFile()))
      return ts.skipOuterExpressions(receiver.arguments[0]);
  }
}

function isNumberType(type: TypeAdapter, allowMissing: boolean): boolean {
  if (type.isUnion() && type.types) return type.types.every((member) => isNumberType(member, allowMissing));
  return (
    Boolean(type.flags & ts.TypeFlags.NumberLike) || (allowMissing && Boolean(type.flags & ts.TypeFlags.Undefined))
  );
}

function checkSortExtreme(call: CallExpression, { checker, report }: PerformanceRuleContext): void {
  const method = call.expression;
  if (
    !ts.isPropertyAccessExpression(method) ||
    ts.isOptionalChain(call) ||
    call.arguments.length !== 1 ||
    (method.name.text !== 'toSorted' && method.name.text !== 'sort')
  )
    return;
  const endpoint = usedEndpoint(call);
  if (!endpoint) return;
  const order = comparisonDirection(call.arguments[0]);
  if (!order) return;
  const receiver = ts.skipOuterExpressions(method.expression);
  const input = method.name.text === 'toSorted' ? receiver : privateCopySource(receiver, checker);
  if (!input || !ts.isIdentifier(input)) return;
  const array = checker.getTypeAtLocation(input).getSymbol();
  if (
    !array ||
    (array.name !== 'Array' && array.name !== 'ReadonlyArray') ||
    !array.declarations?.some((declaration: Node) => isDefaultLibrary(checker, declaration.getSourceFile()))
  )
    return;
  if (
    !isStandardArrayCall(call, checker) ||
    (ts.isCallExpression(endpoint.value) && !isStandardArrayCall(endpoint.value, checker)) ||
    !isNumberType(checker.getTypeAtLocation(endpoint.value), true) ||
    !order.callback.parameters.every((parameter: ParameterDeclaration) =>
      isNumberType(checker.getTypeAtLocation(parameter.name), false),
    )
  )
    return;
  const extreme = order.ascending === endpoint.last ? 'maximum' : 'minimum';
  report(
    method.name,
    'numeric-sort-for-extreme',
    `Sorting the whole array to read one end costs O(n log n). For dense numbers without NaN, track a running ${extreme} in one pass; empty input must still yield undefined and signed-zero ties must keep the element the sort picked.`,
  );
}

export { checkSortExtreme };
