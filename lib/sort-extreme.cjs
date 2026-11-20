'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { isStandardArrayCall, outerExpression, standardInterface } = require('./repeated.cjs');

function observedValue(node) {
  const value = outerExpression(node);
  const use = value.parent;
  if (ts.isReturnStatement(use) || ts.isArrowFunction(use)) return use.expression === value || use.body === value;
  if (ts.isVariableDeclaration(use) || ts.isPropertyAssignment(use)) return use.initializer === value;
  if (ts.isCallExpression(use)) return use.arguments.includes(value);
  if (ts.isBinaryExpression(use)) {
    if (use.operatorToken.kind === ts.SyntaxKind.EqualsToken) return use.right === value;
    if (use.operatorToken.kind === ts.SyntaxKind.CommaToken && use.left === value) return false;
    return !ts.isAssignmentOperator(use.operatorToken.kind) && observedValue(use);
  }
  return false;
}

function usedEndpoint(call) {
  const sorted = outerExpression(call);
  const access = sorted.parent;
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

function comparisonDirection(compare) {
  const callback = ts.skipOuterExpressions(compare);
  if (
    (!ts.isFunctionExpression(callback) && !ts.isArrowFunction(callback)) ||
    callback.asteriskToken ||
    ts.getCombinedModifierFlags(callback) & ts.ModifierFlags.Async ||
    callback.parameters.length !== 2 ||
    callback.parameters.some(
      (parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken,
    )
  )
    return;
  let body = callback.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return;
    body = body.statements[0].expression;
    if (!body) return;
  }
  const result = ts.skipOuterExpressions(body);
  if (!ts.isBinaryExpression(result) || result.operatorToken.kind !== ts.SyntaxKind.MinusToken) return;
  const left = ts.skipOuterExpressions(result.left);
  const right = ts.skipOuterExpressions(result.right);
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text === right.text) return;
  const [first, second] = callback.parameters;
  if (left.text === first.name.text && right.text === second.name.text) return { ascending: true, callback };
  if (left.text === second.name.text && right.text === first.name.text) return { ascending: false, callback };
}

function privateCopySource(receiver, checker) {
  if (
    ts.isArrayLiteralExpression(receiver) &&
    receiver.elements.length === 1 &&
    ts.isSpreadElement(receiver.elements[0])
  ) {
    return ts.skipOuterExpressions(receiver.elements[0].expression);
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

function isNumberType(type, allowMissing) {
  if (type.isUnion()) return type.types.every((member) => isNumberType(member, allowMissing));
  return (
    Boolean(type.flags & ts.TypeFlags.NumberLike) || (allowMissing && Boolean(type.flags & ts.TypeFlags.Undefined))
  );
}

function checkSortExtreme(call, { checker, report }) {
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
    !array.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
  )
    return;
  if (
    !isStandardArrayCall(call, checker) ||
    (ts.isCallExpression(endpoint.value) && !isStandardArrayCall(endpoint.value, checker)) ||
    !isNumberType(checker.getTypeAtLocation(endpoint.value), true) ||
    !order.callback.parameters.every((parameter) => isNumberType(checker.getTypeAtLocation(parameter.name), false))
  )
    return;
  const extreme = order.ascending === endpoint.last ? 'maximum' : 'minimum';
  report(
    method.name,
    'numeric-sort-for-extreme',
    `Sorting the full array to read one end costs extra work. For dense numbers without NaN, compute the ${extreme} in one pass with a running value. Preserve undefined on empty input and tie behavior, including signed zero.`,
  );
}

module.exports = { checkSortExtreme };
