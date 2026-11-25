import type { CallExpression, Expression, MemberName, Statement } from 'typescript';

/**
 * How the page and its total are read: a TypeORM query builder, a TypeORM repository or a Prisma
 * delegate.
 */
export type PageCountKind = 'query-builder' | 'repository' | 'prisma';

/** An awaited `const name = receiver.method(...)` statement. */
export interface CountedCall {
  name: string;
  call: CallExpression;
  method: MemberName;
  receiver: Expression;
}

/**
 * The total count and the page of rows of two calls, before the statements around them are known.
 */
export interface PageCountMatch {
  kind: PageCountKind;
  count: CountedCall;
  rows: CountedCall;
  receiver: Expression;
}

/** A total count and the page of rows for one filter, awaited one after another. */
export interface PageCountPair extends PageCountMatch {
  first: CountedCall;
  second: CountedCall;
  /** From the first awaited statement to the second, with the harmless statements between them. */
  statements: Statement[];
}
