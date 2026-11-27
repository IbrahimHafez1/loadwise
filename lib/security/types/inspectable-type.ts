import type { SymbolAdapter, TypeAdapter } from '../../shared/types.js';

/**
 * A type seen through the compiler members rules probe beyond the shared surface. Each exists on the TypeScript 6
 * type objects; callers use them optionally.
 */
export interface InspectableType extends TypeAdapter {
  objectFlags?: number;
  /** The generic type a type reference instantiates. */
  target?: InspectableType;
  isUnionOrIntersection?(): boolean;
  isIntersection?(): boolean;
  isClassOrInterface?(): boolean;
  getProperties?(): readonly SymbolAdapter[];
}
