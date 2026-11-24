// Site fixes for collection rules. Each builder returns undefined unless the rewrite provably keeps
// behavior.
import { membershipFix } from './collection-membership.cjs';
import { findFix } from './collection-find.cjs';
import { filterExistenceFix, sortExtremeFix } from './collection-existence.cjs';
import { reduceCopyFix, loopCopyFix } from './collection-copy.cjs';
import { rebuildLookupFix, promiseCombinatorFix, knownReadsFix } from './collection-lookups.cjs';

export default {
  'array-repeated-membership': membershipFix,
  'array-repeated-find': findFix,
  'filter-for-existence': filterExistenceFix,
  'numeric-sort-for-extreme': sortExtremeFix,
  'reduce-copy-accumulator': reduceCopyFix,
  'loop-copy-accumulator': loopCopyFix,
  'rebuild-lookup-in-loop': rebuildLookupFix,
  'promise-combinator-serial-await': promiseCombinatorFix,
  'known-reads-awaited-serially': knownReadsFix,
};
