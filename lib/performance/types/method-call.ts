import type { CallExpression, PropertyAccessExpression } from 'typescript';

/** A call written as `receiver.method(...)`. */
export interface MethodCall extends CallExpression {
  expression: PropertyAccessExpression;
}
