import { loadSyntax, isDefaultLibrary } from './compiler.cjs';
import { standardInterface } from './repeated.cjs';
import type { CallExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, TypeAdapter } from '../shared/types.cjs';
const ts = loadSyntax();

function simpleArgument(node: Node): boolean {
  return (
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function hasPromiseType(type: TypeAdapter, checker: CheckerAdapter): boolean {
  if (type.isUnion()) return (type.types ?? []).every((member) => hasPromiseType(member, checker));
  const symbol = type.getSymbol();
  return (
    (symbol?.name === 'Promise' || symbol?.name === 'PromiseLike') &&
    (symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile())) ?? false)
  );
}

function isAwaitedOperation(element: Expression, checker: CheckerAdapter): boolean {
  // Ignore assertion wrappers that could give a synchronous call an apparent Promise type.
  while (ts.isParenthesizedExpression(element)) element = element.expression;
  if (!ts.isAwaitExpression(element)) return false;
  let call: Expression = element.expression;
  while (ts.isParenthesizedExpression(call)) call = call.expression;
  if (!ts.isCallExpression(call) || ts.isOptionalChain(call) || !call.arguments.every(simpleArgument)) return false;
  const target = call.expression;
  if (!ts.isIdentifier(target)) {
    if (
      !ts.isPropertyAccessExpression(target) ||
      !ts.isIdentifier(target.expression) ||
      target.expression.text === 'Promise' ||
      ts.isOptionalChain(target)
    )
      return false;
    const declarations = checker.getSymbolAtLocation(target.name)?.declarations;
    // A method signature excludes getters that produce functions and dynamic callable properties.
    if (
      !declarations?.length ||
      !declarations.every(
        (node) => node.kind === ts.SyntaxKind.MethodSignature || node.kind === ts.SyntaxKind.MethodDeclaration,
      )
    )
      return false;
  }
  return hasPromiseType(checker.getTypeAtLocation(call), checker);
}

function checkPromiseAwait(call: CallExpression, { checker, report }: PerformanceRuleContext): void {
  const target = call.expression;
  if (
    !ts.isPropertyAccessExpression(target) ||
    !ts.isIdentifier(target.expression) ||
    target.expression.text !== 'Promise' ||
    (target.name.text !== 'all' && target.name.text !== 'allSettled') ||
    ts.isOptionalChain(call) ||
    ts.isOptionalChain(target) ||
    call.arguments.length !== 1
  )
    return;
  const array = call.arguments[0];
  if (!ts.isArrayLiteralExpression(array) || array.elements.length < 2) return;
  if (!array.elements.every((element) => ts.isAwaitExpression(element) || ts.isParenthesizedExpression(element)))
    return;
  const constructor = checker.getSymbolAtLocation(target.expression)?.valueDeclaration;
  if (
    !constructor ||
    !isDefaultLibrary(checker, constructor.getSourceFile()) ||
    standardInterface(call, checker) !== 'PromiseConstructor' ||
    !array.elements.every((element) => isAwaitedOperation(element, checker))
  )
    return;

  const rejection =
    target.name.text === 'allSettled'
      ? 'A rejection currently skips allSettled. Passing the pending calls would return rejected entries for those failures.'
      : 'Starting the calls together can run later work even if an earlier call rejects.';
  report(
    target.name,
    'promise-combinator-serial-await',
    `These calls are awaited one at a time before Promise.${target.name.text} receives them, so their latency adds up. Start them together with \`Promise.${target.name.text}([first(), second()])\` if ordering and side effects allow it. ${rejection}`,
  );
}

export { checkPromiseAwait };
