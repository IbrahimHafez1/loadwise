import { loadSyntax, isDefaultLibrary } from './compiler.cjs';
import { isAsyncFunction } from './function-kinds.cjs';
import type { CallExpression, CatchClause, Node, ReturnStatement } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, TypeAdapter } from '../shared/types.cjs';
const ts = loadSyntax();

const ruleId = 'promise-return-escapes-catch';
const standardPromiseInterfaces = new Set(['Promise', 'PromiseLike']);

function returnsInsideLocalCatch(statement: ReturnStatement) {
  let guarded = false;
  let child: Node = statement;
  for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent))
      return guarded && !('asteriskToken' in parent && parent.asteriskToken) && isAsyncFunction(parent);
    if (ts.isTryStatement(parent) && child === parent.tryBlock && parent.catchClause) guarded = true;
  }
  return false;
}

function guardingCatch(statement: ReturnStatement): CatchClause | undefined {
  let child: Node = statement;
  for (let parent = child.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
    if (ts.isTryStatement(parent) && child === parent.tryBlock && parent.catchClause) return parent.catchClause;
  }
}

function callsInside(node: Node) {
  const calls: CallExpression[] = [];
  (function visit(child: Node) {
    if (child !== node && ts.isFunctionLike(child)) return;
    if (ts.isCallExpression(child)) calls.push(child);
    ts.forEachChild(child, visit);
  })(node);
  return calls;
}

// `try { return withCache(load) } catch { return load() }`: the catch is a fallback that reruns the
// returned work, so awaiting would run that work a second time after it rejects.
function catchRepeatsEscapedCall(statement: ReturnStatement) {
  if (!statement.expression) return false;
  const value = ts.skipOuterExpressions(statement.expression);
  const guard = guardingCatch(statement);
  if (!guard || !ts.isCallExpression(value)) return false;
  const sourceFile = statement.getSourceFile();
  const repeatedCallees = new Set([value.expression.getText(sourceFile)]);
  for (const argument of value.arguments) if (ts.isIdentifier(argument)) repeatedCallees.add(argument.text);
  return callsInside(guard.block).some((call) =>
    repeatedCallees.has(ts.skipOuterExpressions(call.expression).getText(sourceFile)),
  );
}

function isStandardPromise(type: TypeAdapter, checker: CheckerAdapter): boolean {
  if (type.isUnion()) return (type.types ?? []).every((member) => isStandardPromise(member, checker));
  return (
    type.getProperty('then')?.declarations?.some((declaration) => {
      const owner = declaration.parent;
      return (
        ts.isInterfaceDeclaration(owner) &&
        standardPromiseInterfaces.has(owner.name.text) &&
        isDefaultLibrary(checker, declaration.getSourceFile())
      );
    }) ?? false
  );
}

function checkPromiseReturnEscapesCatch(statement: ReturnStatement, { checker, report }: PerformanceRuleContext) {
  if (!statement.expression) return;
  const value = ts.skipOuterExpressions(statement.expression);
  if (ts.isAwaitExpression(value) || !returnsInsideLocalCatch(statement)) return;
  if (!isStandardPromise(checker.getTypeAtLocation(value), checker)) return;
  report(
    statement,
    ruleId,
    'A rejection from this returned promise bypasses the local catch because the try does not await it. Use `return await` inside the try if the catch should handle the rejection.',
    catchRepeatsEscapedCall(statement)
      ? 'The catch runs the same work again as a fallback, so letting this rejection escape is likely deliberate: awaiting it would run that work twice.'
      : undefined,
  );
}

export { checkPromiseReturnEscapesCatch, catchRepeatsEscapedCall };
