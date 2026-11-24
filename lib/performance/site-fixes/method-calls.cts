import { ts } from './helpers.cjs';
import type { Node } from 'typescript';
import type { MethodCall } from '../types/method-call.cjs';

// A call written as `receiver.method(...)`.
function isMethodCall(node: Node): node is MethodCall {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);
}

export { isMethodCall };
