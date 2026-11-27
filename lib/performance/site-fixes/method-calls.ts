import { ts } from './helpers.js';
import type { Node } from 'typescript';
import type { MethodCall } from '../types/method-call.js';

// A call written as `receiver.method(...)`.
function isMethodCall(node: Node): node is MethodCall {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);
}

export { isMethodCall };
