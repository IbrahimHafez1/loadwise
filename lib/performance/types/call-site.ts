import type { AwaitExpression, BindingName, CallExpression, Expression, ForOfStatement } from 'typescript';

/** What the call site loops over and how its per-item names are bound. */
interface SiteBase {
  collection: Expression;
  binding: BindingName;
  names: Set<string>;
}

/** `Promise.all(list.map((item) => helper(item)))`. */
export interface AllSite extends SiteBase {
  kind: 'all';
  all: CallExpression;
}

/** `for (const item of list) await helper(item);` */
export interface LoopSite extends SiteBase {
  kind: 'loop';
  loop: ForOfStatement;
  awaited: AwaitExpression;
}

/** `await helper(key)` somewhere in a for-of body. */
export interface PrefetchSite extends SiteBase {
  kind: 'prefetch';
  loop: ForOfStatement;
  awaited: AwaitExpression;
}

export type CallSite = AllSite | LoopSite | PrefetchSite;
