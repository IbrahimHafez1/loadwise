// What the site fix for array-repeated-find needs to index `receiver.find(...)` with a typed Map.
// Types only.

export interface FindLookupFacts {
  /** The Map key type covering every probe used with this array and key path, or `unknown`. */
  keyType: string;
  /** The stored key type already accepts every probe, so `new Map(entries)` can infer it. */
  inferKey: boolean;
  /** A key can be NaN, so NaN keys must be filtered to match strict equality. */
  numericKey: boolean;
  /**
   * Every element is non-nullish and the key is a plain property, so building the index early
   * cannot throw.
   */
  eager: boolean;
}
