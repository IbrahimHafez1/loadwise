import { loadSyntax } from './compiler.cjs';
import { isStandardArrayCall, standardInterface } from './repeated.cjs';
import type {
  AwaitExpression,
  CallExpression,
  ElementAccessExpression,
  Expression,
  MemberName,
  PropertyAccessExpression,
} from 'typescript';
import type { CheckerAdapter } from '../shared/types.cjs';
import type { MethodCall } from './types/method-call.cjs';
const ts = loadSyntax();
const promiseConsumers = new Set(['all', 'allSettled', 'any', 'race']);

/**
 * The `receiver.method` name of a chained call that filters or sorts a query result, and the field
 * it tests.
 */
interface ClientSideQuery {
  method: MemberName;
  field: string;
}

/**
 * A callback `(a, b) => expression` with only plain identifier parameters, and the expression it
 * returns.
 */
interface CallbackResult {
  parameters: string[];
  result: Expression;
}

function outsideWrappers(expression: Expression): Expression {
  while (ts.isOuterExpression(expression.parent) && expression.parent.expression === expression) {
    expression = expression.parent;
  }
  return expression;
}

function isDiscardedValue(value: Expression): boolean {
  let expression = outsideWrappers(value);
  while (
    ts.isBinaryExpression(expression.parent) &&
    expression.parent.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    if (expression.parent.left === expression) return true;
    expression = outsideWrappers(expression.parent);
  }
  return ts.isExpressionStatement(expression.parent) || ts.isVoidExpression(expression.parent);
}

function awaitedResult(call: Expression): AwaitExpression | undefined {
  const expression = outsideWrappers(call);
  const awaited = expression.parent;
  if (ts.isAwaitExpression(awaited) && awaited.expression === expression) return awaited;
}

function firstElementRead(receiver: Expression): ElementAccessExpression | undefined {
  const expression = outsideWrappers(receiver);
  const access = expression.parent;
  if (
    !ts.isElementAccessExpression(access) ||
    access.expression !== expression ||
    !ts.isNumericLiteral(access.argumentExpression) ||
    access.argumentExpression.text !== '0'
  )
    return;

  // A write can target either the array slot or a field on the selected row.
  let use = outsideWrappers(access);
  while (
    (ts.isPropertyAccessExpression(use.parent) || ts.isElementAccessExpression(use.parent)) &&
    use.parent.expression === use
  ) {
    use = outsideWrappers(use.parent);
  }
  if (!ts.isAssignmentTarget(use) && !ts.isDeleteExpression(use.parent) && !isDiscardedValue(use)) return access;
}

function standardPromiseConsumer(argument: Expression, checker: CheckerAdapter, single: boolean) {
  const consumer = argument.parent;
  if (
    !ts.isCallExpression(consumer) ||
    consumer.arguments[0] !== argument ||
    !ts.isPropertyAccessExpression(consumer.expression)
  )
    return false;
  const name = consumer.expression.name.text;
  return (
    (single ? name === 'resolve' : promiseConsumers.has(name)) &&
    standardInterface(consumer, checker) === 'PromiseConstructor'
  );
}

function consumesLazyQuery(call: Expression, checker: CheckerAdapter): boolean {
  const expression = outsideWrappers(call);
  if (ts.isAwaitExpression(expression.parent)) return true;
  if (ts.isArrayLiteralExpression(expression.parent))
    return standardPromiseConsumer(outsideWrappers(expression.parent), checker, false);
  if (ts.isCallExpression(expression.parent)) return standardPromiseConsumer(expression, checker, true);
  const callback =
    ts.isArrowFunction(expression.parent) && expression.parent.body === expression
      ? expression.parent
      : ts.isReturnStatement(expression.parent) && ts.findAncestor(expression.parent, ts.isFunctionLike);
  if (!callback || ('asteriskToken' in callback && callback.asteriskToken)) return false;
  if ('modifiers' in callback && callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    return true;
  // Only a function expression can be passed on as an argument.
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
  const argument = outsideWrappers(callback);
  const map = argument.parent;
  if (
    !ts.isCallExpression(map) ||
    map.arguments[0] !== argument ||
    !ts.isPropertyAccessExpression(map.expression) ||
    map.expression.name.text !== 'map'
  )
    return false;
  const items = outsideWrappers(map);
  // Building an array of thenables does not execute them. Native Promise combinators consume it.
  return standardPromiseConsumer(items, checker, false) && isStandardArrayCall(map, checker);
}

function isMethodCall(call: CallExpression, property: PropertyAccessExpression): call is MethodCall {
  return call.expression === property;
}

function chainedMethod(receiver: Expression): MethodCall | undefined {
  const expression = outsideWrappers(receiver);
  const property = expression.parent;
  if (!ts.isPropertyAccessExpression(property) || property.expression !== expression) return;
  const call = property.parent;
  if (ts.isCallExpression(call) && isMethodCall(call, property)) return call;
}

function callbackResult(call: CallExpression, arity: number): CallbackResult | undefined {
  if (call.arguments.length !== 1) return;
  const callback = call.arguments[0];
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.asteriskToken ||
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    callback.parameters.length !== arity ||
    !callback.parameters.every(
      (parameter) => ts.isIdentifier(parameter.name) && !parameter.initializer && !parameter.dotDotDotToken,
    )
  )
    return;
  let result: Expression | undefined;
  if (ts.isBlock(callback.body)) {
    const [onlyStatement] = callback.body.statements;
    if (callback.body.statements.length !== 1 || !ts.isReturnStatement(onlyStatement)) return;
    result = onlyStatement.expression;
  } else result = callback.body;
  if (result)
    return {
      parameters: callback.parameters.flatMap((parameter) =>
        ts.isIdentifier(parameter.name) ? [parameter.name.text] : [],
      ),
      result: ts.skipOuterExpressions(result),
    };
}

function fieldOn(expression: Expression, parameter: string): string | undefined {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === parameter
  )
    return expression.name.text;
}

function scalarLiteral(expression: Expression): boolean {
  if (
    ts.isStringLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  )
    return true;
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken)
    expression = expression.operand;
  return ts.isNumericLiteral(expression) && Number.isFinite(Number(expression.text));
}

function equalityFilter(call: CallExpression): string | undefined {
  const callback = callbackResult(call, 1);
  if (
    !callback ||
    !ts.isBinaryExpression(callback.result) ||
    callback.result.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  )
    return;
  const { left, right } = callback.result;
  if (scalarLiteral(right)) return fieldOn(left, callback.parameters[0]);
  if (scalarLiteral(left)) return fieldOn(right, callback.parameters[0]);
}

function topKSort(call: CallExpression): string | undefined {
  const slice = chainedMethod(call);
  if (
    !firstElementRead(call) &&
    !(
      slice?.expression.name.text === 'slice' &&
      !isDiscardedValue(slice) &&
      slice.arguments.length === 2 &&
      ts.isNumericLiteral(slice.arguments[0]) &&
      slice.arguments[0].text === '0' &&
      ts.isNumericLiteral(slice.arguments[1]) &&
      Number.isSafeInteger(Number(slice.arguments[1].text)) &&
      Number(slice.arguments[1].text) > 0
    )
  )
    return;
  const callback = callbackResult(call, 2);
  if (
    !callback ||
    !ts.isBinaryExpression(callback.result) ||
    callback.result.operatorToken.kind !== ts.SyntaxKind.MinusToken
  )
    return;
  const { left, right } = callback.result;
  for (const [first, second] of [callback.parameters, [...callback.parameters].reverse()]) {
    const field = fieldOn(left, first);
    if (field && fieldOn(right, second) === field) return field;
  }
}

function clientSideQuery(receiver: Expression): ClientSideQuery | undefined {
  const call = chainedMethod(receiver);
  if (!call || isDiscardedValue(call)) return;
  const method = call.expression.name;
  const field = method.text === 'filter' ? equalityFilter(call) : method.text === 'sort' && topKSort(call);
  if (field) return { method, field };
}

export {
  awaitedResult,
  chainedMethod,
  clientSideQuery,
  consumesLazyQuery,
  firstElementRead,
  isDiscardedValue,
  outsideWrappers,
};
