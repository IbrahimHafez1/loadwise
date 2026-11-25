// @ts-check
// AGENTS.md and the pre-commit hook hold loadwise text between start and end markers. Markers written under earlier
// tool names count too, so one rerun turns an older install, even one block per former checker, into one block.
// Text outside the blocks is never changed.
import type { MarkerPair } from './types/managed-blocks.js';

interface BlockRange {
  start: number;
  end: number;
}

interface BlockStart {
  start: number;
  endMarker: string;
}

function markerStarts(text: string, markerPairs: readonly MarkerPair[]): BlockStart[] {
  const starts: BlockStart[] = [];
  for (const [startMarker, endMarker] of markerPairs) {
    for (let start = text.indexOf(startMarker); start !== -1; start = text.indexOf(startMarker, start + 1))
      starts.push({ start, endMarker });
  }
  return starts.sort((left, right) => left.start - right.start);
}

// A block ends at its end marker only when no other start marker comes first. A start marker that
// lost its end marker covers just its own line: the text after it may be the user's, so it is never
// removed.
function blockRanges(text: string, markerPairs: readonly MarkerPair[]): BlockRange[] {
  const starts = markerStarts(text, markerPairs);
  const ranges: BlockRange[] = [];
  for (let index = 0; index < starts.length; index++) {
    const { start, endMarker } = starts[index];
    const nextStart = starts[index + 1]?.start ?? text.length;
    const end = text.indexOf(endMarker, start);
    if (end !== -1 && end < nextStart) ranges.push({ start, end: end + endMarker.length });
    else {
      const lineEnd = text.indexOf('\n', start);
      ranges.push({ start, end: lineEnd === -1 ? text.length : lineEnd });
    }
  }
  return ranges;
}

// Joins the text around a removed block, keeping the wider of the two line breaks so no blank-line
// gap is left.
function joinAround(before: string, after: string): string {
  const trailing = /\n*$/.exec(before)?.[0] ?? '';
  const leading = /^\n*/.exec(after)?.[0] ?? '';
  if (!after.slice(leading.length)) return before ? before.slice(0, before.length - trailing.length) + '\n' : '';
  if (!before) return after.slice(leading.length);
  const lineBreak = trailing.length > leading.length ? trailing : leading;
  return before.slice(0, before.length - trailing.length) + lineBreak + after.slice(leading.length);
}

// Puts `block` where the first managed block was and removes the others (all of them when `block`
// is undefined). Returns undefined when the text holds no managed block.
function replaceBlocks(text: string, markerPairs: readonly MarkerPair[], block?: string): string | undefined {
  const [first, ...others] = blockRanges(text, markerPairs);
  if (!first) return undefined;
  // Removing from the end keeps the offsets of the earlier blocks valid.
  let result = text;
  for (const range of others.reverse()) result = joinAround(result.slice(0, range.start), result.slice(range.end));
  if (block === undefined) return joinAround(result.slice(0, first.start), result.slice(first.end));
  return result.slice(0, first.start) + block + result.slice(first.end);
}

export { replaceBlocks };
