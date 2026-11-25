import type { CallExpression, Expression, ForStatement, TaggedTemplateExpression, WhileStatement } from 'typescript';
import type { RepeatOwner } from './repeat-owner.js';

/** A query is a call, or for a raw Prisma statement a tagged template. */
export type QueryCall = CallExpression | TaggedTemplateExpression;

/** A loop that pages with no end condition of its own: `while (true)` or `for (;;)`. */
export type PageScan = WhileStatement | ForStatement;

/**
 * What identifies the query and the loop it repeats in; the owner defaults to the nearest repeating
 * loop.
 */
export interface LoopQueryOptions {
  family?: string;
  method?: string;
  owner?: RepeatOwner;
  insertRows?: Expression;
}
