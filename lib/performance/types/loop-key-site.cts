import type { ForOfLoopBinding, LoopLookupSite } from './loop-lookup.cjs';

/**
 * What a key lookup needs of the loop: the names the item binds and the names the body declares or
 * writes.
 */
export type LoopKeySite = Pick<ForOfLoopBinding, 'names' | 'locals'> &
  Partial<Pick<LoopLookupSite, 'loop' | 'statement'>>;
