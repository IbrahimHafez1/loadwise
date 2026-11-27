import type { SpanTiming } from '../span-timing.js';
import type { DuplicateReads } from '../cache-reads.js';
import type { DuplicateReadGroup, OtlpObservedSpan } from './otlp-attributes.js';

/** A JSON object as read from an OTLP export, before any member is validated. */
export type OtlpRecord = Record<string, unknown>;

/**
 * A span once its numeric kind and status code were validated; the other members stay as exported.
 */
export interface OtlpSpan extends OtlpObservedSpan {
  traceId?: unknown;
  spanId?: unknown;
  parentSpanId?: unknown;
  name?: unknown;
  kind?: number;
  attributes?: unknown;
}

/** Sibling database spans that share one operation signature under one parent. */
export interface RepeatedSpanGroup extends DuplicateReadGroup {
  ruleId: string;
  exampleSpanId: string;
  batchParent: string | null;
  signatureKind: string;
  readCommand: string;
  timing: SpanTiming;
}

/** What one inspection accumulates while it walks the export. */
export interface TraceState {
  seen: Set<string>;
  groups: Map<string, RepeatedSpanGroup>;
  signatures: Map<string, string>;
  batchParents: Set<string>;
  duplicateReads: DuplicateReads;
  /**
   * The attribute keys of the last span that had no database attributes, to skip re-validating the
   * layout.
   */
  nonDatabaseKeys?: string[];
  lastTraceId?: string;
  lastParentId?: string;
}
