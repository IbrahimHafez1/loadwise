// A decorator read as a call: `@Index('a')` or a bare `@Index`.
import type { CallExpression, Expression, Identifier } from 'typescript';

export interface DecoratorCall {
  name: string;
  callee: Identifier;
  /** Absent for a bare `@Index`. */
  call?: CallExpression;
  args: readonly Expression[];
}
