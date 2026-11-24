import type { CallExpression, MemberName, PropertyAccessExpression } from 'typescript';

/**
 * The `select` in `db.select()...`: the name at the start of a builder chain, inside the call that
 * makes the builder.
 */
export type DrizzleRoot = MemberName & { parent: PropertyAccessExpression & { parent: CallExpression } };

/** One builder method call of a chain, such as `.where(...)`. */
export interface DrizzleStep {
  name: string;
  call: CallExpression;
}

/** A Drizzle builder chain: its root, then the steps from the last call back towards the root. */
export interface DrizzleQuery {
  root: DrizzleRoot;
  steps: DrizzleStep[];
  hasSetOperation: boolean;
}
