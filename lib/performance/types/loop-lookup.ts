// What the per-item query rewrites share: a for-of whose body awaits one read per item, the key
// that read filters by, and the options the builders pass to the keyed and grouped lookup rewrites.
// Types only.
import type {
  AwaitExpression,
  BindingName,
  Expression,
  ForOfStatement,
  Node,
  ObjectLiteralElementLike,
  SourceFile,
  Statement,
} from 'typescript';

/** The list a for-of walks, as text that can be listed again before the loop. */
export interface LoopItemSource {
  text: string;
  kind: 'array' | 'iterable';
  fixed: boolean;
  method?: string;
  owner?: string;
  ownerKind?: string;
}

/**
 * A for-of whose items can be listed again before it: its binding, collection and the names its
 * body writes.
 */
export interface ForOfLoopBinding {
  loop: ForOfStatement;
  pattern: BindingName;
  names: ReadonlySet<string>;
  source: LoopItemSource;
  locals: ReadonlySet<string>;
}

/** A read awaited once per item of a for-of. */
export interface LoopLookupSite extends ForOfLoopBinding {
  statement: Statement;
  awaited: AwaitExpression;
  guarded: boolean;
  earlierAwaits: AwaitExpression[];
  laterAwaits: AwaitExpression[];
}

/**
 * The filter property that depends on the item; `properties` is the whole filter when the key came
 * from one.
 */
export interface LoopItemKey {
  field: string;
  value: Expression;
  perItem: Node;
  property?: ObjectLiteralElementLike;
  properties?: ReadonlyMap<string, ObjectLiteralElementLike>;
}

/**
 * The inputs of keyedLookup and groupedLookup: where the batched rows go and how each item reads
 * its own.
 */
export interface LookupRewrite {
  site: LoopLookupSite;
  sourceFile: SourceFile;
  rowsBase: string;
  rowName: string;
  field: string;
  keyValue: Expression;
  fetchLine?: string;
  note: string;
  setup?: string[];
  fetched?: string;
  keyOf?: (text: string) => string;
}
