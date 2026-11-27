import type { ArrowFunction, FunctionExpression, IterationStatement, MethodDeclaration } from 'typescript';

/**
 * The loop or iteration callback that runs a node once per item. `findRepeatOwner` yields undefined when nothing
 * repeats the node; the Prisma rule also treats a callback on an untyped receiver, which may be a method, as an owner.
 */
export type RepeatOwner = IterationStatement | FunctionExpression | ArrowFunction | MethodDeclaration;
