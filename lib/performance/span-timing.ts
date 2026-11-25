import type { LoopImpact } from '../shared/types.js';

/** One OTLP span; the timestamps arrive as strings or numbers, and either may be missing. */
interface TimedSpan {
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
}

type Interval = [start: number, end: number];

const NANOSECONDS_PER_MILLISECOND = 1e6;
const UNSIGNED_INTEGER = /^\d+$/;

function nanoseconds(value: unknown): number {
  if (typeof value === 'string') return UNSIGNED_INTEGER.test(value) ? Number(value) : NaN;
  return typeof value === 'number' && value >= 0 ? value : NaN;
}

// Collects the start/end times of one group of spans. A single missing or invalid timestamp
// voids the whole group, because a partial union would understate the cost.
class SpanTiming {
  intervals: Interval[] | null = [];
  valid = true;

  add(span: TimedSpan): void {
    if (!this.valid || !this.intervals) return;
    const start = nanoseconds(span.startTimeUnixNano);
    const end = nanoseconds(span.endTimeUnixNano);
    if (!(end >= start)) {
      this.valid = false;
      this.intervals = null;
      return;
    }
    this.intervals.push([start, end]);
  }

  impact(): LoopImpact | undefined {
    if (!this.valid || !this.intervals?.length) return;
    const sorted = this.intervals.slice().sort((left, right) => left[0] - right[0]);
    let union = 0;
    let slowest = 0;
    let [currentStart, currentEnd] = sorted[0];
    for (const [start, end] of sorted) {
      slowest = Math.max(slowest, end - start);
      if (start > currentEnd) {
        union += currentEnd - currentStart;
        currentStart = start;
        currentEnd = end;
      } else if (end > currentEnd) {
        currentEnd = end;
      }
    }
    union += currentEnd - currentStart;
    return {
      kind: 'estimated',
      measured: ['before'],
      before: union / NANOSECONDS_PER_MILLISECOND,
      after: slowest / NANOSECONDS_PER_MILLISECOND,
      unit: 'ms',
      method: 'OTLP start/end times; after assumes one batched operation costs as much as the slowest span',
    };
  }
}

export { SpanTiming };
