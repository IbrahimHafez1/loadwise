'use strict';

const NANOSECONDS_PER_MILLISECOND = 1e6;
const UNSIGNED_INTEGER = /^\d+$/;

function nanoseconds(value) {
  if (typeof value === 'string') return UNSIGNED_INTEGER.test(value) ? Number(value) : NaN;
  return typeof value === 'number' && value >= 0 ? value : NaN;
}

// Collects the start/end times of one group of spans. A single missing or invalid timestamp
// voids the whole group, because a partial union would understate the cost.
class SpanTiming {
  intervals = [];
  valid = true;

  add(span) {
    if (!this.valid) return;
    const start = nanoseconds(span.startTimeUnixNano);
    const end = nanoseconds(span.endTimeUnixNano);
    if (!(end >= start)) {
      this.valid = false;
      this.intervals = null;
      return;
    }
    this.intervals.push([start, end]);
  }

  impact() {
    if (!this.valid || !this.intervals.length) return;
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

module.exports = { SpanTiming };
