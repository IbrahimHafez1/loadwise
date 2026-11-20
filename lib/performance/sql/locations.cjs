'use strict';

// Positions are 1-based line and 1-based UTF-16 column (what editors and the TypeScript API report).

function collectLineStarts(text) {
  const lineStartChars = [0];
  const lineStartBytes = [0];
  let byteOffset = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) byteOffset += 1;
    else if (code < 0x800) byteOffset += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one 4-byte UTF-8 sequence.
      byteOffset += 4;
      index += 1;
    } else byteOffset += 3;
    if (code === 10) {
      lineStartChars.push(index + 1);
      lineStartBytes.push(byteOffset);
    }
  }
  return { lineStartChars, lineStartBytes, totalBytes: byteOffset };
}

function findLineIndex(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function utf8Length(codePoint) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

// Precomputed once per file so each lookup is a binary search plus a walk within one line.
function createPositionIndex(text) {
  const { lineStartChars, lineStartBytes, totalBytes } = collectLineStarts(text);

  function fromCharOffset(charOffset) {
    const clamped = Math.max(0, Math.min(charOffset, text.length));
    const lineIndex = findLineIndex(lineStartChars, clamped);
    return { line: lineIndex + 1, column: clamped - lineStartChars[lineIndex] + 1 };
  }

  function byteToCharOffset(byteOffset) {
    if (byteOffset >= totalBytes) return text.length;
    const lineIndex = findLineIndex(lineStartBytes, Math.max(0, byteOffset));
    let bytes = lineStartBytes[lineIndex];
    let charOffset = lineStartChars[lineIndex];
    while (charOffset < text.length && bytes < byteOffset) {
      const codePoint = text.codePointAt(charOffset);
      bytes += utf8Length(codePoint);
      charOffset += codePoint > 0xffff ? 2 : 1;
    }
    return charOffset;
  }

  return {
    fromCharOffset,
    byteToCharOffset,
    fromByteOffset: (byteOffset) => fromCharOffset(byteToCharOffset(byteOffset)),
  };
}

let lastIndexedText = null;
let lastIndex = null;

function byteOffsetToPosition(text, byteOffset) {
  if (lastIndexedText !== text) {
    lastIndex = createPositionIndex(text);
    lastIndexedText = text;
  }
  return lastIndex.fromByteOffset(byteOffset);
}

// literalStart is the position of the first character of the raw template text (after the backtick).
function positionInTemplate(literalStart, rawText, charOffset) {
  const before = rawText.slice(0, Math.max(0, charOffset));
  const lastNewline = before.lastIndexOf('\n');
  if (lastNewline === -1) {
    return { line: literalStart.line, column: literalStart.column + before.length };
  }
  const lineBreaks = before.split('\n').length - 1;
  return { line: literalStart.line + lineBreaks, column: before.length - lastNewline };
}

module.exports = { createPositionIndex, byteOffsetToPosition, positionInTemplate };
