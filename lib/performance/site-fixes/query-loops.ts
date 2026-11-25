// Rewrites per-item queries inside a for-of loop into one batched query before the loop, and single
// queries that load every row only to count, pick or filter them. Any shape not proven safe is left
// to the rule example. The builders live in the query-loop-* modules; this one registers them by rule
// id and re-exports the helpers batch-loops.cjs shares.
import {
  someNode,
  textWith,
  isReference,
  mentions,
  readsOnlyNames,
  plainProperties,
  indentationOf,
} from './query-loop-nodes.js';
import { plural, capitalized, usableName } from './query-loop-names.js';
import { forOfBinding, loopLookup, inlinedLocal, itemKeyFilter, itemKeys, loopWorkNote } from './query-loop-sites.js';
import { mapItems } from './query-loop-collections.js';
import {
  keyedLookup,
  indentationStep,
  groupedLookup,
  groupedKeyNote,
  nullKeyNote,
  ownIdKey,
  mapKeyNote,
  duplicateKeyNote,
  joinNotes,
  invariantOptions,
  whereWith,
} from './query-loop-lookups.js';
import { prismaQueryInLoop } from './query-loop-prisma.js';
import { ormQueryInLoop } from './query-loop-typeorm.js';
import { pgQueryInLoop, redisCommandInLoop } from './query-loop-pg-redis.js';
import {
  prismaCountMaterialization,
  prismaFirstMaterialization,
  prismaFilterMaterialization,
  prismaTopKMaterialization,
  pgFirstMaterialization,
  pgCountMaterialization,
} from './query-loop-materialization.js';

export default {
  'prisma-query-in-loop': prismaQueryInLoop,
  'orm-query-in-loop': ormQueryInLoop,
  'pg-query-in-loop': pgQueryInLoop,
  'redis-command-in-loop': redisCommandInLoop,
  'prisma-count-materialization': prismaCountMaterialization,
  'prisma-first-materialization': prismaFirstMaterialization,
  'prisma-filter-materialization': prismaFilterMaterialization,
  'prisma-top-k-materialization': prismaTopKMaterialization,
  'pg-first-materialization': pgFirstMaterialization,
  'pg-count-materialization': pgCountMaterialization,
};

// The default export is the rule builder registry; helpers shared with batch-loops.cjs are a
// separate named export.
export const shared = {
  someNode,
  loopLookup,
  forOfBinding,
  itemKeyFilter,
  itemKeys,
  inlinedLocal,
  loopWorkNote,
  keyedLookup,
  groupedLookup,
  whereWith,
  invariantOptions,
  plainProperties,
  readsOnlyNames,
  mapItems,
  usableName,
  capitalized,
  plural,
  ownIdKey,
  mentions,
  joinNotes,
  textWith,
  indentationOf,
  indentationStep,
  isReference,
  mapKeyNote,
  groupedKeyNote,
  nullKeyNote,
  duplicateKeyNote,
  typeormQueryInLoop: ormQueryInLoop,
};
