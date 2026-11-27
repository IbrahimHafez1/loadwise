// `regex-from-input`: request text compiled as a regular expression, by `RegExp`, by a string
// method that converts its argument to a pattern, or as a MongoDB `$regex` operand.
import { ts } from '../../performance/compiler.js';
import { reportTraced, isGlobalName } from './shared.js';
import type { CallExpression, Expression, NewExpression, PropertyAssignment, PropertyName } from 'typescript';
import type { SecurityRuleContext, TypeAdapter } from '../../shared/types.js';

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

// `text.search(...)` and `text['search'](...)` call the same method.
function stringMethodCall(call: CallExpression) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isPropertyAccessExpression(callee)) return { receiver: callee.expression, method: callee.name.text };
  if (!ts.isElementAccessExpression(callee)) return;
  const key = ts.skipOuterExpressions(callee.argumentExpression);
  return ts.isStringLiteralLike(key) ? { receiver: callee.expression, method: key.text } : undefined;
}

// A union such as `string | RegExp` can still be compiled as a pattern when it holds a string.
function canBeString(type: TypeAdapter): boolean {
  if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  return type.isUnion() && (type.types?.some(canBeString) ?? false);
}

function checkCall(node: CallExpression | NewExpression, context: SecurityRuleContext) {
  const callee = ts.skipOuterExpressions(node.expression);
  if (isGlobalName(callee, regexConstructors, context.checker)) return reportPattern(node.arguments?.[0], context);
  if (!ts.isCallExpression(node)) return;
  const stringCall = stringMethodCall(node);
  if (stringCall === undefined || !patternMethods.has(stringCall.method)) return;
  const [pattern] = node.arguments;
  if (!pattern) return;
  if (!(context.checker.getTypeAtLocation(stringCall.receiver).flags & ts.TypeFlags.StringLike)) return;
  // A RegExp object built elsewhere is reported where it is built.
  if (!canBeString(context.checker.getTypeAtLocation(pattern))) return;
  reportPattern(pattern, context);
}

// The decoded name of a static property key: `$regex`, `'$regex'` and `['$regex']`.
function staticKeyName(name: PropertyName) {
  if (ts.isComputedPropertyName(name)) {
    const key = ts.skipOuterExpressions(name.expression);
    return ts.isStringLiteralLike(key) ? key.text : undefined;
  }
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function checkRegexOperator(property: PropertyAssignment, context: SecurityRuleContext) {
  if (staticKeyName(property.name) !== '$regex') return;
  reportPattern(property.initializer, context);
}

export { checkCall, checkRegexOperator };
