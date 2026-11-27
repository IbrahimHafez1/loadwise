// `regex-catastrophic-backtracking`: a fixed regular expression that can backtrack exponentially or
// polynomially runs on request text. The pattern check is a small, conservative parser: anything it
// does not fully understand (backreferences, Unicode property escapes, the `v` flag, inline
// modifiers) is skipped rather than guessed.
import { ts } from '../../performance/compiler.js';
import { reportTraced, isGlobalName, methodName, initializerOf } from './shared.js';
import type { CallExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter, SecurityRuleContext } from '../../shared/types.js';
import { createParser, normalize, overlaps, maxCodePoint, Unsupported } from './regex-pattern.js';
import type { CodePointRange, PatternNode } from './regex-pattern.js';

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

type BacktrackingKind = 'exponential' | 'polynomial';

interface FixedRegex {
  source: string;
  flags: string;
}

interface RegexUse {
  regex: Expression;
  subject: Expression;
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

// The character set at each position of an alternative made only of single characters, or
// undefined when its length can vary.
function fixedPositions(node: PatternNode): CodePointRange[][] | undefined {
  const unwrapped = unwrapGroups(node);
  if (unwrapped.kind === 'char') return [unwrapped.ranges];
  if (unwrapped.kind !== 'seq') return;
  const positions: CodePointRange[][] = [];
  for (const item of unwrapped.items) {
    const itemPositions = fixedPositions(item);
    if (!itemPositions) return;
    positions.push(...itemPositions);
  }
  return positions;
}

// Same-length fixed alternatives such as `ab|ac` match the same text only when every position
// overlaps; sharing a first character alone leaves each iteration one way to match.
function alternativesCanMatchSameText(left: PatternNode, right: PatternNode) {
  const leftPositions = fixedPositions(left);
  const rightPositions = fixedPositions(right);
  if (leftPositions && rightPositions && leftPositions.length === rightPositions.length) {
    return leftPositions.every((positionRanges, index) => overlaps(positionRanges, rightPositions[index]));
  }
  return overlaps(firstSet(left), firstSet(right));
}

function hasOverlappingAlternatives(node: PatternNode) {
  const body = unwrapGroups(node);
  if (body.kind !== 'alt') return false;
  return body.alternatives.some((alternative, index) =>
    body.alternatives.slice(index + 1).some((other) => alternativesCanMatchSameText(alternative, other)),
  );
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

function isEveryCharacter(ranges: readonly CodePointRange[]) {
  return ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === maxCodePoint;
}

// The first atom of `node`, looking into groups and sequences, so `(^[\t ]*)` starts with `^`.
function leadingAtom(node: PatternNode): PatternNode {
  let current = node;
  while (current.kind === 'group' || (current.kind === 'seq' && current.items.length > 0))
    current = current.kind === 'group' ? current.body : current.items[0];
  return current;
}

// `.*` alone, or a group that is `.*` after optional single characters only (`(\/?.*)`).
function isDotRunEnding(node: PatternNode) {
  const body = unwrapGroups(node);
  const items = body.kind === 'seq' ? body.items : [body];
  const last = items.at(-1);
  const characters = last && repeatedCharacters(last);
  return (
    Boolean(characters && isEveryCharacter(characters)) &&
    items.slice(0, -1).every((item) => !canFail(item) && edgeRunCharacters(item, false).length === 0)
  );
}

function isTrailingDotEndAnchor(items: readonly PatternNode[], index: number, followed: boolean): boolean {
  if (followed || index === 0) return false;
  const first = leadingAtom(items[0]);
  if (first.kind !== 'assert' || first.anchor !== '^') return false;
  const tail = items.slice(index + 1);
  if (tail.length !== 1 || tail[0].kind !== 'assert' || tail[0].anchor !== '$') return false;
  return isDotRunEnding(items[index]);
}

// The characters of the unbounded character repeats inside `node` that one end of its match can
// begin with, because everything between that end and the repeat can match empty: `\s*` in
// `(?:\(?\w*\)?\s*=>)?` from the start, or in `(?:x\s*)+` from the end. Assertions and required
// characters stop the walk.
function edgeRunCharacters(node: PatternNode, fromEnd: boolean): CodePointRange[] {
  const characters = repeatedCharacters(node);
  if (characters) return characters;
  switch (node.kind) {
    case 'group':
      return edgeRunCharacters(node.body, fromEnd);
    case 'quant':
      // A `{0}` body never runs. An unbounded loop whose body can match a single character
      // (`(?:a\s*)+`) is itself a run over those characters.
      if (node.max === 0) return [];
      if (node.max !== Infinity) return edgeRunCharacters(node.body, fromEnd);
      return normalize([...singleCharacters(node.body), ...edgeRunCharacters(node.body, fromEnd)]);
    case 'alt':
      return normalize(node.alternatives.flatMap((alternative) => edgeRunCharacters(alternative, fromEnd)));
    case 'seq': {
      const ranges: CodePointRange[] = [];
      const items = fromEnd ? [...node.items].reverse() : node.items;
      for (const item of items) {
        ranges.push(...edgeRunCharacters(item, fromEnd));
        if (canFail(item)) break;
      }
      return normalize(ranges);
    }
    default:
      return [];
  }
}

// The characters `node` can match as a whole one-character match: `a` for `a\s*`.
function singleCharacters(node: PatternNode): CodePointRange[] {
  switch (node.kind) {
    case 'char':
      return node.ranges;
    case 'group':
      return singleCharacters(node.body);
    case 'alt':
      return normalize(node.alternatives.flatMap(singleCharacters));
    case 'quant':
      return node.max === 0 || node.min > 1 ? [] : singleCharacters(node.body);
    case 'seq': {
      // An assertion limits where each turn can start, so turns cannot each take one character of a run.
      if (node.items.some((item) => item.kind === 'assert' || item.kind === 'lookaround')) return [];
      const required = node.items.filter((item) => !nullable(item));
      if (required.length > 1) return [];
      if (required.length === 1) return singleCharacters(required[0]);
      return normalize(node.items.flatMap(singleCharacters));
    }
    default:
      return [];
  }
}

// The items of a sequence with plain (unquantified, single-branch) groups spliced in, so
// `^a*(?:a+$)` is checked like `^a*a+$`.
function flattenGroups(items: readonly PatternNode[]): PatternNode[] {
  return items.flatMap((item) => {
    if (item.kind !== 'group' || item.body.kind === 'alt') return [item];
    return flattenGroups(item.body.kind === 'seq' ? item.body.items : [item.body]);
  });
}

// Two unbounded repeats over overlapping characters with nothing required between them
// (`\s+.*\s+$`,
// `\w+\s*\w+$`) can split one run of n characters in n ways. The split is only retried when
// something after them can fail, so `/\d+\w*/` alone is quiet. Repeats of longer bodies
// (`(ab)+(ac)+`) are left alone: their first characters can overlap without any text matching both.
// A repeat at the edge of a group or loop counts too: the trailing `\s*` of `(?:\w+\(\)\s*)+` and
// a later `\s*` split the same run, as do `^\s*` and the `\s*` inside an optional `(?:\w*\s*=>)?`.
function hasAmbiguousRun(sequence: readonly PatternNode[], followed: boolean) {
  const items = flattenGroups(sequence);
  // Characters of the repeats that the next item can take over because everything since them can
  // match empty.
  let reachable: CodePointRange[] = [];
  for (const [index, item] of items.entries()) {
    const characters = repeatedCharacters(item);
    if (
      overlaps(reachable, characters ?? edgeRunCharacters(item, false)) &&
      (followed || items.slice(index + 1).some(canFail)) &&
      !isTrailingDotEndAnchor(items, index, followed)
    )
      return true;
    const trailing = characters ?? edgeRunCharacters(item, true);
    reachable = canFail(item) ? trailing : normalize([...reachable, ...trailing]);
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

// A cut at a huge literal such as `1e9` does not shorten the input in practice. A negative end
// is a prefix expression, not a numeric literal, so it never counts as a cap.
const maxTruncationLength = 10_000;

function isShortLimit(limit: Expression) {
  return ts.isNumericLiteral(limit) && Number(limit.text) <= maxTruncationLength;
}

// `text.slice(0, 200)`: a fixed-length cut keeps the input short enough for polynomial patterns.
// `substring` swaps its arguments when the start is larger, so `substring(start, 200)` returns
// everything from 200 to `start`; it needs a literal start too.
function isTruncated(subject: Expression) {
  const node = ts.skipOuterExpressions(subject);
  const method = ts.isCallExpression(node) ? methodName(node) : undefined;
  if (!ts.isCallExpression(node) || method === undefined || !truncatingMethods.has(method)) return false;
  const [start, end] = node.arguments;
  if (node.arguments.length !== 2 || !isShortLimit(ts.skipOuterExpressions(end))) return false;
  return method !== 'substring' || ts.isNumericLiteral(ts.skipOuterExpressions(start));
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

// A length cap silences only polynomial findings, so exponential ones are told to rewrite.
const remedyWording: Record<BacktrackingKind, string> = {
  exponential:
    'Rewrite the pattern to remove the nested or overlapping repetition so no part can match the same text in two ways; a length cap does not make it safe.',
  polynomial: 'Rewrite the pattern so no part can match the same text in two ways, or cap the input length first.',
};

function message(label: string, kind: BacktrackingKind) {
  return `This regular expression can backtrack ${growthWording[kind]} on \`${label}\` (ReDoS), blocking the event loop. ${remedyWording[kind]}`;
}

function checkCall(node: CallExpression, context: SecurityRuleContext) {
  const parts = regexAndSubject(node);
  if (!parts?.regex || !parts.subject || ts.isSpreadElement(parts.subject)) return;
  const regex = fixedRegex(parts.regex, context.checker);
  const kind = regex && backtrackingKind(regex.source, regex.flags);
  // A cap keeps polynomial work small, but exponential backtracking is already catastrophic at a
  // few dozen characters, so a cut such as `slice(0, 254)` does not make it safe.
  if (!kind || (kind === 'polynomial' && isTruncated(parts.subject))) return;
  const trace = context.taint.trace(parts.subject, 'regex');
  if (trace) return reportTraced(context, node, ruleId, message(trace.label, kind), trace);
  const parameterName = parameterSubjectName(parts.subject, context.checker);
  if (parameterName) {
    reportTraced(context, node, ruleId, message(parameterName, kind), undefined, parameterReason);
  }
}

export { checkCall, isCatastrophicPattern };
