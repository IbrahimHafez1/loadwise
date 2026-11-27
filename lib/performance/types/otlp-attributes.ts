/**
 * One OTLP attribute value; exporters set exactly one member. Integers arrive as numbers or decimal
 * strings.
 */
export interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  boolValue?: boolean;
  doubleValue?: number | string;
  arrayValue?: { values?: OtlpValue[] };
}

/** The validated attributes of a span or resource, by key. */
export type OtlpAttributes = ReadonlyMap<string, OtlpValue>;

/** The span members the duplicate-read check inspects. */
export interface OtlpObservedSpan {
  status?: { code?: number };
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
}

/** The repeated-span group a duplicate read belongs to. */
export interface DuplicateReadGroup {
  traceId: string;
  parentSpanId: string;
  system: string;
  count: number;
}
