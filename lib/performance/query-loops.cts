import { isBoundedLoop, isGrownLater, matchesOneItemValue } from './query-loop-bounds.cjs';
import { batchPredicate, isBatchCollection } from './query-loop-batch.cjs';
import { onFailurePath, probesUntilFree, retriesUntilSuccess, runsAtMostOnce } from './query-loop-exits.cjs';
import { readProperty } from './query-loop-helpers.cjs';
import { isMemoised } from './query-loop-memo.cjs';
import { advancesPageCursor } from './query-loop-pagination.cjs';
import { findRepeatOwner } from './repeated.cjs';
import type { CheckerAdapter } from '../shared/types.cjs';
import type { LoopQueryOptions, QueryCall } from './types/query-loops.cjs';

function shouldReportLoopQuery(
  call: QueryCall,
  checker: CheckerAdapter,
  { family, method, owner = findRepeatOwner(call, checker), insertRows }: LoopQueryOptions = {},
): boolean {
  if (
    !owner ||
    runsAtMostOnce(call, owner, checker) ||
    probesUntilFree(call, owner, checker) ||
    retriesUntilSuccess(call, owner, checker)
  )
    return false;
  if (isBoundedLoop(owner, checker) || matchesOneItemValue(call, owner, checker)) return false;
  if (isMemoised(call, checker, owner) || onFailurePath(call)) return false;
  if (insertRows && isBatchCollection(insertRows, owner, checker)) return false;
  // Tagged templates such as a raw Prisma statement have no argument list.
  const options = 'arguments' in call ? call.arguments[0] : undefined;
  const bulkRead =
    (family === 'Prisma' && (method === 'groupBy' || method === 'findMany')) ||
    (family === 'TypeORM' && (method === 'find' || method === 'findBy'));
  if (!bulkRead || !options) return true;
  const filter = method === 'findBy' ? options : readProperty(options, 'where');
  return !batchPredicate(filter, owner, checker, family) && !advancesPageCursor(call, owner, options, checker);
}

export type { LoopQueryOptions };
export { isBatchCollection, isGrownLater, isMemoised, shouldReportLoopQuery };
