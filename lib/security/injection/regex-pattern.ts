// The small, conservative regex parser behind `regex-catastrophic-backtracking`, plus the code point
// range helpers it builds on. Anything it does not fully understand (backreferences, Unicode
// property escapes, inline modifiers) throws `Unsupported`, and the caller treats the pattern as safe.

/** An inclusive range of code points. */
type CodePointRange = [low: number, high: number];

interface CharNode {
  kind: 'char';
  ranges: CodePointRange[];
}

interface AssertNode {
  kind: 'assert';
  /** '^' or '$' for an anchor; absent for a word boundary. */
  anchor?: string;
}

/** A capture or non-capture group. */
interface GroupNode {
  kind: 'group';
  body: PatternNode;
}

/** `(?=`, `(?!`, `(?<=` or `(?<!`. */
interface LookaroundNode {
  kind: 'lookaround';
  body: PatternNode;
}

interface AlternationNode {
  kind: 'alt';
  alternatives: PatternNode[];
}

interface SequenceNode {
  kind: 'seq';
  items: PatternNode[];
}

interface QuantifierNode {
  kind: 'quant';
  body: PatternNode;
  min: number;
  max: number;
}

type PatternNode = CharNode | AssertNode | GroupNode | LookaroundNode | AlternationNode | SequenceNode | QuantifierNode;

/**
 * One escape or class member: a single code point, or the ranges of a class escape such as `\d`.
 */
interface ClassAtom {
  ranges?: CodePointRange[];
  code?: number;
}

interface QuantifierBounds {
  min: number;
  max: number;
  length: number;
}

const maxCodePoint = 0x10ffff;
const everyCharacter: CodePointRange[] = [[0, maxCodePoint]];
const digitRanges: CodePointRange[] = [[0x30, 0x39]];
const wordRanges: CodePointRange[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
const spaceRanges: CodePointRange[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const controlEscapes: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, f: 0x0c, 0: 0x00 };
const classEscapes: Record<string, CodePointRange[]> = { d: digitRanges, w: wordRanges, s: spaceRanges };
const upperToLowerOffset = 0x20;

// Thrown when the parser meets syntax it does not model; the pattern is then treated as safe.
class Unsupported extends Error {}

// ---- Character sets: sorted, merged [low, high] code point ranges. ----

function normalize(ranges: readonly CodePointRange[]): CodePointRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: CodePointRange[] = [];
  for (const [low, high] of sorted) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

function complement(ranges: readonly CodePointRange[]): CodePointRange[] {
  const result: CodePointRange[] = [];
  let next = 0;
  for (const [low, high] of normalize(ranges)) {
    if (low > next) result.push([next, low - 1]);
    next = high + 1;
  }
  if (next <= maxCodePoint) result.push([next, maxCodePoint]);
  return result;
}

function overlaps(left: readonly CodePointRange[], right: readonly CodePointRange[]) {
  return left.some(([low, high]) => right.some(([otherLow, otherHigh]) => low <= otherHigh && otherLow <= high));
}

// Adds the other case of every ASCII letter in the set, for the `i` flag.
function foldCase(ranges: readonly CodePointRange[]): CodePointRange[] {
  const folded = [...ranges];
  for (const [low, high] of ranges) {
    for (const [letterLow, letterHigh, offset] of [
      [0x41, 0x5a, upperToLowerOffset],
      [0x61, 0x7a, -upperToLowerOffset],
    ]) {
      const from = Math.max(low, letterLow);
      const to = Math.min(high, letterHigh);
      if (from <= to) folded.push([from + offset, to + offset]);
    }
  }
  return normalize(folded);
}

// ---- Parser: pattern text -> { kind: 'char' | 'assert' | 'group' | 'alt' | 'seq' | 'quant' |
// 'lookaround' } ----

function createParser(source: string, flags: string): () => PatternNode {
  let position = 0;
  const ignoreCase = flags.includes('i');

  const peek = (offset = 0) => source[position + offset];
  const atEnd = () => position >= source.length;

  function charNode(ranges: readonly CodePointRange[]): CharNode {
    return { kind: 'char', ranges: ignoreCase ? foldCase(ranges) : normalize(ranges) };
  }

  function codePointAt() {
    const codePoint = source.codePointAt(position);
    if (codePoint === undefined) throw new Unsupported();
    position += codePoint > 0xffff ? 2 : 1;
    return codePoint;
  }

  function readHex(length: number) {
    const digits = source.slice(position, position + length);
    if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) throw new Unsupported();
    position += length;
    return parseInt(digits, 16);
  }

  // A single code point escape (`\n`, `\x41`, `A`, `\u{41}`, `\.`), or a class escape's ranges.
  function readEscape(inClass: boolean): ClassAtom {
    position++;
    const letter = peek();
    if (letter === undefined) throw new Unsupported();
    position++;
    if (classEscapes[letter]) return { ranges: classEscapes[letter] };
    if (classEscapes[letter.toLowerCase()]) return { ranges: complement(classEscapes[letter.toLowerCase()]) };
    if (letter in controlEscapes && !(letter === '0' && /\d/.test(peek() ?? '')))
      return { code: controlEscapes[letter] };
    if (letter === 'x') return { code: readHex(2) };
    if (letter === 'u' && peek() === '{') {
      const close = source.indexOf('}', position);
      if (close < 0) throw new Unsupported();
      const digits = source.slice(position + 1, close);
      if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) throw new Unsupported();
      position = close + 1;
      return { code: parseInt(digits, 16) };
    }
    if (letter === 'u') return { code: readHex(4) };
    if (inClass && letter === 'b') return { code: 0x08 };
    // Backreferences, `\k<name>`, `\p{...}`, `\c` and octal escapes change matching in ways not
    // modelled here.
    if (/[0-9kpPc]/.test(letter)) throw new Unsupported();
    return { code: letter.codePointAt(0) };
  }

  function readClassAtom(): ClassAtom {
    if (peek() === '\\') return readEscape(true);
    return { code: codePointAt() };
  }

  function parseClass(): CharNode {
    position++;
    const negated = peek() === '^';
    if (negated) position++;
    const ranges: CodePointRange[] = [];
    while (peek() !== ']') {
      if (atEnd()) throw new Unsupported();
      const start = readClassAtom();
      if (peek() === '-' && peek(1) !== ']' && peek(1) !== undefined && start.code !== undefined) {
        position++;
        const end = readClassAtom();
        if (end.code === undefined || end.code < start.code) throw new Unsupported();
        ranges.push([start.code, end.code]);
        continue;
      }
      if (start.ranges) ranges.push(...start.ranges);
      else if (start.code !== undefined) ranges.push([start.code, start.code]);
    }
    position++;
    const members = ignoreCase ? foldCase(ranges) : ranges;
    return { kind: 'char', ranges: negated ? complement(members) : normalize(members) };
  }

  // The group kind for the text after `(`, consuming its `?:`, `?=`, `?<!` or `?<name>` prefix.
  function readGroupKind(): GroupNode['kind'] | LookaroundNode['kind'] {
    if (peek() !== '?') return 'group';
    const opener = source.slice(position, position + 3);
    if (['?=', '?!'].includes(opener.slice(0, 2)) || ['?<=', '?<!'].includes(opener)) {
      position += opener.startsWith('?<') ? 3 : 2;
      return 'lookaround';
    }
    const nameEnd = source.indexOf('>', position);
    if (opener.startsWith('?:')) position += 2;
    else if (opener.startsWith('?<') && nameEnd > 0) position = nameEnd + 1;
    else throw new Unsupported();
    return 'group';
  }

  let groupDepth = 0;

  function parseGroup(): GroupNode | LookaroundNode {
    if (++groupDepth > 64) throw new Unsupported();
    try {
      position++;
      const kind = readGroupKind();
      const body = parseAlternation();
      if (peek() !== ')') throw new Unsupported();
      position++;
      return { kind, body };
    } finally {
      groupDepth--;
    }
  }

  // Consumes `length` characters and returns `node`.
  function consume<Parsed extends PatternNode>(length: number, node: Parsed): Parsed {
    position += length;
    return node;
  }

  function parseAtom(): PatternNode {
    const character = peek();
    if (character === '^' || character === '$') return consume(1, { kind: 'assert', anchor: character });
    if (character === '(') return parseGroup();
    if (character === '[') return parseClass();
    if (character === '.') return consume(1, charNode(everyCharacter));
    if (character === '\\' && (peek(1) === 'b' || peek(1) === 'B')) return consume(2, { kind: 'assert' });
    if (character === '\\') {
      const escape = readEscape(false);
      if (escape.ranges) return charNode(escape.ranges);
      if (escape.code === undefined) throw new Unsupported();
      return charNode([[escape.code, escape.code]]);
    }
    if (
      character === '*' ||
      character === '+' ||
      character === '?' ||
      character === ')' ||
      (character === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(position)))
    )
      throw new Unsupported();
    const code = codePointAt();
    return charNode([[code, code]]);
  }

  // `{n}`, `{n,}`, `{n,m}`, `*`, `+`, `?` (lazy or not), or undefined.
  function readQuantifier(): QuantifierBounds | undefined {
    const character = peek();
    let bounds: QuantifierBounds;
    if (character === '*') bounds = { min: 0, max: Infinity, length: 1 };
    else if (character === '+') bounds = { min: 1, max: Infinity, length: 1 };
    else if (character === '?') bounds = { min: 0, max: 1, length: 1 };
    else if (character === '{') {
      const braces = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(position));
      if (!braces) return;
      const min = Number(braces[1]);
      const max = braces[2] === undefined ? min : braces[3] === '' ? Infinity : Number(braces[3]);
      bounds = { min, max, length: braces[0].length };
    } else return;
    position += bounds.length;
    if (peek() === '?') position++;
    return bounds;
  }

  function parseSequence(): SequenceNode {
    const items: PatternNode[] = [];
    while (!atEnd() && peek() !== '|' && peek() !== ')') {
      const atom = parseAtom();
      const bounds = readQuantifier();
      if (!bounds) {
        items.push(atom);
        continue;
      }
      if (atom.kind === 'assert' || atom.kind === 'lookaround') throw new Unsupported();
      items.push({ kind: 'quant', body: atom, min: bounds.min, max: bounds.max });
    }
    return { kind: 'seq', items };
  }

  function parseAlternation(): PatternNode {
    const alternatives: PatternNode[] = [parseSequence()];
    while (peek() === '|') {
      position++;
      alternatives.push(parseSequence());
    }
    return alternatives.length === 1 ? alternatives[0] : { kind: 'alt', alternatives };
  }

  return function parse(): PatternNode {
    const tree = parseAlternation();
    if (!atEnd()) throw new Unsupported();
    return tree;
  };
}

export { createParser, normalize, overlaps, maxCodePoint, Unsupported };
export type { CodePointRange, PatternNode };
