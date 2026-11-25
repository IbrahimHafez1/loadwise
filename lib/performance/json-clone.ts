import { ts } from './compiler.js';
import { enclosingRequestHandler } from './request-handlers.js';
import type { CallExpression, Node } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';

const RULE_ID = 'json-roundtrip-clone';
const MESSAGE =
  '`JSON.parse(JSON.stringify(value))` serialises and re-parses the whole value on every call, which costs CPU and memory on a hot path. Use `structuredClone(value)` or copy only the fields you change. Note that the JSON round trip also turns Dates into strings and drops `undefined`, functions, Maps and Sets, so check what the code relies on.';

function isGlobalJsonCall(node: Node, methodName: string): node is CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.skipOuterExpressions(node.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === methodName &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON'
  );
}

function isRoundTrip(node: Node): boolean {
  if (!isGlobalJsonCall(node, 'parse') || node.arguments.length !== 1) return false;
  const inner = ts.skipOuterExpressions(node.arguments[0]);
  return isGlobalJsonCall(inner, 'stringify') && inner.arguments.length === 1;
}

function check(node: Node, context: PerformanceRuleContext): void {
  if (!isRoundTrip(node)) return;
  // A one-off clone at startup or in a script is cheap; only per-request or per-item clones add up.
  if (!enclosingRequestHandler(node) && !context.isRepeated(node)) return;
  context.report(node, RULE_ID, MESSAGE);
}

export { check };
