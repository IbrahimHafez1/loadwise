// `regex-catastrophic-backtracking`: a fixed regular expression that can backtrack exponentially or
// polynomially runs on request text. The pattern check is a small, conservative parser: anything it
// does not fully understand (backreferences, Unicode property escapes, the `v` flag, inline
// modifiers) is skipped rather than guessed.
import { ts } from '../../performance/compiler.js';
import { reportTraced, isGlobalName, methodName, initializerOf } from './shared.js';
import type { CallExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter, SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'regex-catastrophic-backtracking';
const regexConstructors = new Set(['RegExp']);
// Methods called on the regex with the subject as the first argument, and string methods taking the
// regex.
const regexMethods = new Set(['test', 'exec']);
const stringMethods = new Set(['match', 'matchAll', 'replace', 'replaceAll', 'split', 'search']);
// String methods that cap the subject's length when given a fixed end, which bounds the
// backtracking.
const truncatingMethods = new Set(['slice', 'substring', 'substr']);
// Bounds the `const` alias chain followed to find a regex.
const maxAliasDepth = 4;

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

type BacktrackingKind = 'exponential' | 'polynomial';

interface FixedRegex {
  source: string;
  flags: string;
}

interface RegexUse {
  regex: Expression;
  subject: Expression;
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
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) throw new Unsupported();
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
    if ('*+?)'.includes(character) || /^\{\d+(,\d*)?\}/.test(source.slice(position))) throw new Unsupported();
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
    else {
      const braces = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(position));
      if (!braces) return;
      const min = Number(braces[1]);
      const max = braces[2] === undefined ? min : braces[3] === '' ? Infinity : Number(braces[3]);
      bounds = { min, max, length: braces[0].length };
    }
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

// ---- Analysis ----

function nullable(node: PatternNode): boolean {
  switch (node.kind) {
    case 'char':
      return false;
    case 'group':
      return nullable(node.body);
    case 'alt':
      return node.alternatives.some(nullable);
    case 'seq':
      return node.items.every(nullable);
    case 'quant':
      return node.min === 0 || nullable(node.body);
    default:
      return true;
  }
}

// The characters a non-empty match of `node` can start with.
function firstSet(node: PatternNode): CodePointRange[] {
  switch (node.kind) {
    case 'char':
      return node.ranges;
    case 'group':
    case 'quant':
      return firstSet(node.body);
    case 'alt':
      return normalize(node.alternatives.flatMap(firstSet));
    case 'seq': {
      const ranges: CodePointRange[] = [];
      for (const item of node.items) {
        ranges.push(...firstSet(item));
        if (!nullable(item)) break;
      }
      return normalize(ranges);
    }
    default:
      return [];
  }
}

// A quantifier that can choose how many times to repeat (`+`, `*`, `{2,4}`); `?` alone is too small
// to matter.
function isVariableRepeat(node: PatternNode) {
  return node.kind === 'quant' && node.max > node.min && node.max > 1;
}

// True when a variable repeat inside `node` could either take one more turn or stop and let
// `follow` (what comes after it, wrapping round to the outer loop's next iteration) take the same
// character.
function hasAmbiguousRepeat(node: PatternNode, follow: readonly CodePointRange[]): boolean {
  switch (node.kind) {
    case 'group':
      return hasAmbiguousRepeat(node.body, follow);
    case 'alt':
      return node.alternatives.some((alternative) => hasAmbiguousRepeat(alternative, follow));
    case 'seq': {
      let after = follow;
      for (let index = node.items.length - 1; index >= 0; index--) {
        const item = node.items[index];
        if (hasAmbiguousRepeat(item, after)) return true;
        after = nullable(item) ? normalize([...firstSet(item), ...after]) : firstSet(item);
      }
      return false;
    }
    case 'quant': {
      const start = firstSet(node.body);
      if (isVariableRepeat(node) && overlaps(start, follow)) return true;
      return hasAmbiguousRepeat(node.body, normalize([...start, ...follow]));
    }
    default:
      return false;
  }
}

function unwrapGroups(node: PatternNode): PatternNode {
  let current: PatternNode = node;
  while (current.kind === 'group' || (current.kind === 'seq' && current.items.length === 1))
    current = current.kind === 'group' ? current.body : current.items[0];
  return current;
}

function hasOverlappingAlternatives(node: PatternNode) {
  const body = unwrapGroups(node);
  if (body.kind !== 'alt') return false;
  const starts = body.alternatives.map(firstSet);
  return starts.some((start, index) => starts.slice(index + 1).some((other) => overlaps(start, other)));
}

// An unbounded loop whose iterations can split the same text in more than one way.
function isAmbiguousLoop(node: PatternNode) {
  if (node.kind !== 'quant' || node.max !== Infinity) return false;
  return hasOverlappingAlternatives(node.body) || hasAmbiguousRepeat(node.body, firstSet(node.body));
}

// Lookaround bodies are skipped: they rarely loop, and their backtracking is cut off when they
// finish.
function someLoop(node: PatternNode, predicate: (node: PatternNode) => boolean): boolean {
  if (predicate(node)) return true;
  switch (node.kind) {
    case 'group':
    case 'quant':
      return someLoop(node.body, predicate);
    case 'alt':
      return node.alternatives.some((alternative) => someLoop(alternative, predicate));
    case 'seq':
      return node.items.some((item) => someLoop(item, predicate));
    default:
      return false;
  }
}

// The characters an unbounded repeat of a single character set matches (`\s+`, `[\w-]*`, `(?:.)*`),
// or undefined. An optional repeat (`(?:\d+)?`, as in ms@0.7.0's duration pattern) counts too: it
// is a repeat that may be empty.
function repeatedCharacters(node: PatternNode): CodePointRange[] | undefined {
  let repeat = unwrapGroups(node);
  if (repeat.kind === 'quant' && repeat.max === 1) repeat = unwrapGroups(repeat.body);
  if (repeat.kind !== 'quant' || repeat.max !== Infinity) return;
  const body = unwrapGroups(repeat.body);
  return body.kind === 'char' ? body.ranges : undefined;
}

// Whether matching `node` can fail at some position: it needs a character, or it is an assertion or
// lookaround.
function canFail(node: PatternNode) {
  return !nullable(node) || node.kind === 'assert' || node.kind === 'lookaround';
}

// Two unbounded repeats over overlapping characters with nothing required between them
// (`\s+.*\s+$`,
// `\w+\s*\w+$`) can split one run of n characters in n ways. The split is only retried when
// something after them can fail, so `/\d+\w*/` alone is quiet. Repeats of longer bodies
// (`(ab)+(ac)+`) are left alone: their first characters can overlap without any text matching both.
function hasAmbiguousRun(items: readonly PatternNode[], followed: boolean) {
  // Characters of the repeats that the next item can take over because everything since them can
  // match empty.
  let reachable: CodePointRange[] = [];
  for (const [index, item] of items.entries()) {
    const characters = repeatedCharacters(item);
    if (!characters) {
      if (canFail(item)) reachable = [];
      continue;
    }
    if (overlaps(reachable, characters) && (followed || items.slice(index + 1).some(canFail))) return true;
    reachable = nullable(item) ? normalize([...reachable, ...characters]) : characters;
  }
  return false;
}

// Polynomial (O(n^2) or worse) backtracking anywhere in the pattern. `followed` says whether
// something after
// `node` can fail.
function hasPolynomialSequence(node: PatternNode, followed = false): boolean {
  switch (node.kind) {
    case 'group':
    case 'quant':
      return hasPolynomialSequence(node.body, followed);
    case 'alt':
      return node.alternatives.some((alternative) => hasPolynomialSequence(alternative, followed));
    case 'seq':
      return (
        hasAmbiguousRun(node.items, followed) ||
        node.items.some((item, index) =>
          hasPolynomialSequence(item, followed || node.items.slice(index + 1).some(canFail)),
        )
      );
    default:
      return false;
  }
}

// A pattern branch that starts with an unbounded character repeat and ends at `$` (`\s*$`, `\d+$`)
// without a leading
// `^`: the search retries it from every position inside a run, and each retry rescans the rest of
// the run (trim@0.0.1).
function hasUnanchoredTrailingRun(ast: PatternNode) {
  const branches = ast.kind === 'alt' ? ast.alternatives : [ast];
  return branches.some(
    (branch) =>
      branch.kind === 'seq' &&
      branch.items.length === 2 &&
      repeatedCharacters(branch.items[0]) &&
      branch.items[1].kind === 'assert' &&
      branch.items[1].anchor === '$',
  );
}

// 'exponential', 'polynomial', or undefined for safe or unparsed patterns.
function backtrackingKind(source: string, flags = ''): BacktrackingKind | undefined {
  if (flags.includes('v')) return;
  try {
    const ast = createParser(source, flags)();
    if (someLoop(ast, isAmbiguousLoop)) return 'exponential';
    if (hasPolynomialSequence(ast) || hasUnanchoredTrailingRun(ast)) return 'polynomial';
  } catch (error) {
    if (error instanceof Unsupported) return;
    throw error;
  }
}

// True when the pattern can backtrack exponentially or polynomially; false for safe or unparsed
// patterns.
function isCatastrophicPattern(source: string, flags = '') {
  return backtrackingKind(source, flags) !== undefined;
}

// ---- Rule ----

function literalText(node: Node | undefined) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
}

// `{ source, flags }` for a regex literal, `RegExp('fixed')` / `new RegExp('fixed', 'flags')`, or a
// `const` holding one; undefined for anything built at runtime.
function fixedRegex(expression: Expression | undefined, checker: CheckerAdapter, depth = 0): FixedRegex | undefined {
  if (!expression || depth > maxAliasDepth) return;
  const node = ts.skipOuterExpressions(expression);
  if (ts.isRegularExpressionLiteral(node)) {
    const closing = node.text.lastIndexOf('/');
    return { source: node.text.slice(1, closing), flags: node.text.slice(closing + 1) };
  }
  if (ts.isIdentifier(node)) return fixedRegex(initializerOf(node, checker), checker, depth + 1);
  if (!(ts.isNewExpression(node) || ts.isCallExpression(node))) return;
  if (!isGlobalName(ts.skipOuterExpressions(node.expression), regexConstructors, checker)) return;
  const [pattern, flagsArgument] = node.arguments ?? [];
  const source = literalText(pattern);
  const flags = flagsArgument === undefined ? '' : literalText(flagsArgument);
  if (source === undefined || flags === undefined) return;
  return { source, flags };
}

// `text.slice(0, 200)`: a fixed-length cut keeps the input short enough.
function isTruncated(subject: Expression) {
  const node = ts.skipOuterExpressions(subject);
  const method = ts.isCallExpression(node) ? methodName(node) : undefined;
  return (
    ts.isCallExpression(node) &&
    method !== undefined &&
    truncatingMethods.has(method) &&
    node.arguments.length === 2 &&
    ts.isNumericLiteral(ts.skipOuterExpressions(node.arguments[1]))
  );
}

const parameterReason =
  'Contextual: the text is a function parameter, so the finding applies only if callers pass untrusted or very long input.';

// The parameter a subject is built from (`input`, `String(input)`, `input.trim()`), or undefined
// for other values.
function parameterSubjectName(subject: Expression, checker: CheckerAdapter) {
  let node = ts.skipOuterExpressions(subject);
  while (ts.isCallExpression(node)) {
    const callee = ts.skipOuterExpressions(node.expression);
    const unwrapped = ts.isPropertyAccessExpression(callee) ? callee.expression : node.arguments[0];
    if (!unwrapped) return;
    node = ts.skipOuterExpressions(unwrapped);
  }
  if (!ts.isIdentifier(node)) return;
  const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
  return declarations.some((declaration) => ts.isParameter(declaration)) ? node.text : undefined;
}

// The regex and the text it runs on, for `regex.test(text)` and `text.match(regex)` style calls.
function regexAndSubject(call: CallExpression): RegexUse | undefined {
  const name = methodName(call);
  const callee = ts.skipOuterExpressions(call.expression);
  if (name === undefined || !ts.isPropertyAccessExpression(callee)) return;
  const receiver = callee.expression;
  if (regexMethods.has(name)) return { regex: receiver, subject: call.arguments[0] };
  if (stringMethods.has(name)) return { regex: call.arguments[0], subject: receiver };
}

// How the backtracking grows with the input length, in the finding's wording.
const growthWording: Record<BacktrackingKind, string> = {
  exponential: 'exponentially',
  polynomial: 'in polynomial time',
};

function message(label: string, kind: BacktrackingKind) {
  return `This regular expression can backtrack ${growthWording[kind]} on \`${label}\` (ReDoS), blocking the event loop. Rewrite the pattern so no part can match the same text in two ways, or cap the input length first.`;
}

function checkCall(node: CallExpression, context: SecurityRuleContext) {
  const parts = regexAndSubject(node);
  if (!parts?.regex || !parts.subject || ts.isSpreadElement(parts.subject) || isTruncated(parts.subject)) return;
  const regex = fixedRegex(parts.regex, context.checker);
  if (!regex || /^\^?Bearer(?:\\s|\[[^\]]*\])\+\(\.\+\)\$$/.test(regex.source)) return;
  const kind = backtrackingKind(regex.source, regex.flags);
  if (!kind) return;
  const trace = context.taint.trace(parts.subject, 'regex');
  if (trace) return reportTraced(context, node, ruleId, message(trace.label, kind), trace);
  const parameterName = parameterSubjectName(parts.subject, context.checker);
  if (parameterName) {
    reportTraced(context, node, ruleId, message(parameterName, kind), undefined, parameterReason);
  }
}

export { checkCall, isCatastrophicPattern };
