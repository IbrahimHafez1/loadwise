import type { ModuleLoadHook } from './module-internals.cjs';

/** Narrows `node:module` to the private `_load` hook, which Node's types do not declare. */
export function hasLoadHook(candidate: object): candidate is ModuleLoadHook {
  return '_load' in candidate && typeof candidate._load === 'function';
}
