// `regex-from-input`: request text compiled as a regular expression, by `RegExp`, by a string
// method that converts its argument to a pattern, or as a MongoDB `$regex` operand.
import { loadSyntax } from '../../performance/compiler.cjs';
import { reportTraced, isGlobalName, methodName } from './shared.cjs';
import type { CallExpression, Expression, NewExpression, PropertyAssignment } from 'typescript';
import type { CheckerAdapter, SecurityRuleContext } from '../../shared/types.cjs';
const ts = loadSyntax();

const ruleId = 'regex-from-input';
const regexConstructors = new Set(['RegExp']);
const patternMethods = new Set(['match', 'matchAll', 'search']);

function message(label: string) {
  return `This regular expression is built from \`${label}\`; a crafted pattern can block the event loop (ReDoS) or match more than intended. Escape the input before building the pattern or use a literal comparison.`;
}

function reportPattern(pattern: Expression | undefined, context: SecurityRuleContext) {
  if (!pattern || ts.isSpreadElement(pattern) || ts.isStringLiteralLike(pattern)) return;
  const trace = context.taint.trace(pattern, 'regex');
  if (!trace) return;
  reportTraced(context, pattern, ruleId, message(trace.label), trace);
}

function isStringReceiver(call: CallExpression, checker: CheckerAdapter) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return Boolean(checker.getTypeAtLocation(callee.expression).flags & ts.TypeFlags.StringLike);
}

function checkCall(node: CallExpression | NewExpression, context: SecurityRuleContext) {
  const callee = ts.skipOuterExpressions(node.expression);
  if (isGlobalName(callee, regexConstructors, context.checker)) return reportPattern(node.arguments?.[0], context);
  if (!ts.isCallExpression(node)) return;
  const method = methodName(node);
  if (method === undefined || !patternMethods.has(method)) return;
  const [pattern] = node.arguments;
  if (!pattern || !isStringReceiver(node, context.checker)) return;
  // A RegExp object built elsewhere is reported where it is built.
  if (
    !(
      context.checker.getTypeAtLocation(pattern).flags &
      (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)
    )
  )
    return;
  reportPattern(pattern, context);
}

function checkRegexOperator(property: PropertyAssignment, context: SecurityRuleContext) {
  if (property.name.getText().replaceAll(/['"]/g, '') !== '$regex') return;
  reportPattern(property.initializer, context);
}

export { checkCall, checkRegexOperator };
