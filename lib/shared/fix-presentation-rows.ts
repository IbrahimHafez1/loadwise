// @ts-check
import type { OwnedRange, Owner, RowRegion, RowSegment, StyleRegion } from './types/fix-presentation.js';
import type { FormattedHunk, UpdateHunk } from './types/fix-run.js';

function splitRows(text: string): string[] {
  return text.split('\n');
}

// Merges overlapping or touching ranges and orders them bottom first, so formatting one leaves the
// rows of the next unchanged.
function bottomFirst(ranges: readonly { start: number; end: number; owners?: ReadonlySet<Owner> }[]): OwnedRange[] {
  const merged: OwnedRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      for (const owner of range.owners ?? []) last.owners.add(owner);
    } else merged.push({ start: range.start, end: range.end, owners: new Set(range.owners) });
  }
  return merged.reverse();
}

// Lines that differ between two texts: `[first, beforeEnd)` of `before` became `[first, afterEnd)`
// of `after`.
function changedRows(beforeRows: readonly string[], afterRows: readonly string[]): RowRegion {
  let first = 0;
  while (first < beforeRows.length && first < afterRows.length && beforeRows[first] === afterRows[first]) first++;
  let same = 0;
  while (
    same < beforeRows.length - first &&
    same < afterRows.length - first &&
    beforeRows[beforeRows.length - 1 - same] === afterRows[afterRows.length - 1 - same]
  )
    same++;
  return { first, beforeEnd: beforeRows.length - same, afterEnd: afterRows.length - same };
}

// Tracks which rows of a file each applied change owns while Prettier rewrites them. A segment is a
// run of rows: unchanged original rows, or rows written by changes (`owners`) that replaced
// `originalLength` original rows.
function segmentsOf(originalRowCount: number, hunks: readonly UpdateHunk[]): RowSegment[] {
  const segments: RowSegment[] = [];
  let cursor = 0;
  for (const hunk of [...hunks].sort((left, right) => left.row - right.row)) {
    if (hunk.row > cursor) segments.push({ length: hunk.row - cursor, originalLength: hunk.row - cursor });
    segments.push({ length: hunk.added, originalLength: hunk.removed, owners: new Set([hunk.key]) });
    cursor = hunk.row + hunk.removed;
  }
  if (originalRowCount > cursor)
    segments.push({ length: originalRowCount - cursor, originalLength: originalRowCount - cursor });
  return segments;
}

function rangesOf(segments: readonly RowSegment[]): OwnedRange[] {
  const ranges: OwnedRange[] = [];
  let row = 0;
  for (const segment of segments) {
    if (segment.owners) ranges.push({ start: row, end: row + segment.length, owners: segment.owners });
    row += segment.length;
  }
  return ranges;
}

// Replaces the segments under rows `[first, end)` with the formatted rows, widened to whole changed
// segments.
function replaceRows(
  segments: readonly RowSegment[],
  { first, beforeEnd, afterEnd }: RowRegion,
  owners: Iterable<Owner>,
): RowSegment[] {
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  // An empty region (Prettier only inserted rows) belongs to the row it was inserted at, or the
  // last row.
  const coverStart = beforeEnd > first ? first : Math.max(0, Math.min(first, total - 1));
  const coverEnd = beforeEnd > first ? beforeEnd : coverStart + 1;
  const before: RowSegment[] = [];
  const covered: RowSegment[] = [];
  const after: RowSegment[] = [];
  let row = 0;
  const side = (start: number, end: number) => (end <= coverStart ? before : start >= coverEnd ? after : covered);
  const splitAtRegionEdges = (segmentStart: number, segmentEnd: number): void => {
    let from = segmentStart;
    for (const cut of [coverStart, coverEnd, segmentEnd].filter((cut) => cut > segmentStart && cut <= segmentEnd)) {
      if (cut <= from) continue;
      side(from, cut).push({ length: cut - from, originalLength: cut - from });
      from = cut;
    }
  };
  for (const segment of segments) {
    const segmentEnd = row + segment.length;
    // Rows a change wrote stay whole; unchanged rows split at the region's edges.
    if (segment.owners) side(row, segmentEnd).push(segment);
    else splitAtRegionEdges(row, segmentEnd);
    row = segmentEnd;
  }
  if (!covered.length) return [...segments];
  const merged: RowSegment = {
    length: covered.reduce((sum, segment) => sum + segment.length, 0) + (afterEnd - beforeEnd),
    originalLength: covered.reduce((sum, segment) => sum + segment.originalLength, 0),
    owners: new Set([...owners, ...covered.flatMap((segment) => [...(segment.owners ?? [])])]),
  };
  return [...before, merged, ...after];
}

const plainRows = (rows: readonly string[]): string => rows.map((row) => row.replace(/\r$/, '')).join('\n');

// Each owner's change as it reads in the formatted file: its original rows and the rows that
// replaced them.
function ownedHunks(
  segments: readonly RowSegment[],
  originalRows: readonly string[],
  formattedRows: readonly string[],
): Map<Owner, FormattedHunk> {
  const hunks = new Map<Owner, { row: number; originalRow: number; end: number; originalEnd: number }>();
  let row = 0;
  let originalRow = 0;
  for (const segment of segments) {
    for (const owner of segment.owners ?? []) {
      const hunk = hunks.get(owner);
      if (!hunk) hunks.set(owner, { row, originalRow, end: row, originalEnd: originalRow });
    }
    row += segment.length;
    originalRow += segment.originalLength;
    for (const owner of segment.owners ?? []) {
      const hunk = hunks.get(owner);
      if (hunk) Object.assign(hunk, { end: row, originalEnd: originalRow });
    }
  }
  return new Map(
    [...hunks].map(([owner, hunk]): [Owner, FormattedHunk] => [
      owner,
      {
        line: hunk.originalRow + 1,
        before: plainRows(originalRows.slice(hunk.originalRow, hunk.originalEnd)),
        after: plainRows(formattedRows.slice(hunk.row, hunk.end)),
      },
    ]),
  );
}

// The segments after each formatting step, where step `index` formatted range `index` of
// `bottomFirst` order.
function followSteps(segments: readonly RowSegment[], text: string, steps: readonly string[]): RowSegment[] {
  const ranges = bottomFirst(rangesOf(segments));
  let previous = splitRows(text);
  let followed = [...segments];
  steps.forEach((stepText: string, index: number) => {
    const next = splitRows(stepText);
    const region = changedRows(previous, next);
    if (region.first < previous.length || previous.length !== next.length)
      followed = replaceRows(followed, region, ranges[index].owners);
    previous = next;
  });
  return followed;
}

// Rows `[start, end)` that changes wrote, each with the rows it replaced.
function styleRegions(
  segments: readonly RowSegment[],
  beforeRowsOf: (segment: RowSegment, originalRow: number) => readonly string[],
): StyleRegion[] {
  const regions: StyleRegion[] = [];
  let row = 0;
  let originalRow = 0;
  for (const segment of segments) {
    if (segment.owners)
      regions.push({ start: row, end: row + segment.length, beforeRows: beforeRowsOf(segment, originalRow) });
    row += segment.length;
    originalRow += segment.originalLength;
  }
  return regions;
}

export {
  bottomFirst,
  changedRows,
  followSteps,
  ownedHunks,
  rangesOf,
  replaceRows,
  segmentsOf,
  splitRows,
  styleRegions,
};
