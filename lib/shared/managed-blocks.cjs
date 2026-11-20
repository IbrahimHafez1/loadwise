'use strict';

// AGENTS.md and the pre-commit hook hold loadwise text between start and end markers. Markers written under earlier
// tool names count too, so one rerun turns an older install, even one block per former checker, into one block.
// Text outside the blocks is never changed.

function blockRanges(text, markerPairs) {
  const ranges = [];
  for (const [startMarker, endMarker] of markerPairs) {
    let start = text.indexOf(startMarker);
    while (start !== -1) {
      const end = text.indexOf(endMarker, start);
      if (end === -1) break;
      ranges.push({ start, end: end + endMarker.length });
      start = text.indexOf(startMarker, end);
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

// Joins the text around a removed block, keeping the wider of the two line breaks so no blank-line gap is left.
function joinAround(before, after) {
  const trailing = /\n*$/.exec(before)[0];
  const leading = /^\n*/.exec(after)[0];
  if (!after.slice(leading.length)) return before ? before.slice(0, before.length - trailing.length) + '\n' : '';
  if (!before) return after.slice(leading.length);
  const lineBreak = trailing.length > leading.length ? trailing : leading;
  return before.slice(0, before.length - trailing.length) + lineBreak + after.slice(leading.length);
}

// Puts `block` where the first managed block was and removes the others (all of them when `block` is undefined).
// Returns undefined when the text holds no managed block.
function replaceBlocks(text, markerPairs, block) {
  const [first, ...others] = blockRanges(text, markerPairs);
  if (!first) return undefined;
  // Removing from the end keeps the offsets of the earlier blocks valid.
  let result = text;
  for (const range of others.reverse()) result = joinAround(result.slice(0, range.start), result.slice(range.end));
  if (block === undefined) return joinAround(result.slice(0, first.start), result.slice(first.end));
  return result.slice(0, first.start) + block + result.slice(first.end);
}

module.exports = { replaceBlocks };
