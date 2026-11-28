// regex-catastrophic-backtracking: a fixed regex with nested or overlapping repetition runs on
// request text. Safe patterns, unparsed patterns, untainted input and length-capped input are
// silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintBothWays, lintWithoutTypes, stubs } from './helpers.js';
import { isCatastrophicPattern } from '../../lib/security/injection/redos.js';
import type { LocatedFinding } from '../types/security.js';

const ruleId = 'regex-catastrophic-backtracking';

const catastrophicPatterns = [
  String.raw`^(a+)+$`,
  String.raw`(x+x+)+y`,
  String.raw`^([a-zA-Z0-9_\.\-])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$`,
  String.raw`(\w*)*`,
  String.raw`([a-z]+)*`,
  String.raw`(.*a){2,}`,
  String.raw`(a|a)*`,
  String.raw`(\w|\d)+`,
  String.raw`(a|ab)*`,
  String.raw`^(\w+\s?)*$`,
  String.raw`(?:[^,]+,?)+$`,
  String.raw`^(?<word>\d+)*$`,
];

const safePatterns = [
  String.raw`^\d+$`,
  String.raw`^[a-z]+(-[a-z]+)*$`,
  String.raw`(ab)+`,
  String.raw`(a|b)+`,
  String.raw`(\d|[a-z])+`,
  String.raw`(a+){2,5}`,
  String.raw`(?:\d{3}-)+`,
  String.raw`^(\s*\w+\s*,)*$`,
  String.raw`(([a-z\-])+\.)+`,
  String.raw`[(a+)+]`,
  String.raw`\(a+\)+`,
];

// Backreferences, property escapes and malformed text are not modelled, so they are skipped rather
// than guessed.
const unparsedPatterns = [String.raw`(a+)+\1`, String.raw`(\p{L}+)+`, String.raw`((a+)+`, String.raw`(?i:a+)+`];

test('nested and overlapping repetition is detected', () => {
  for (const pattern of catastrophicPatterns) assert.equal(isCatastrophicPattern(pattern), true, pattern);
});

test('separated, bounded and single-level repetition is safe', () => {
  for (const pattern of safePatterns) assert.equal(isCatastrophicPattern(pattern), false, pattern);
});

test('patterns the parser does not model are skipped', () => {
  for (const pattern of unparsedPatterns) assert.equal(isCatastrophicPattern(pattern), false, pattern);
  assert.equal(isCatastrophicPattern('(a+)+', 'v'), false);
});

test('the i flag makes letters of either case overlap', () => {
  assert.equal(isCatastrophicPattern('(a|A)+'), false);
  assert.equal(isCatastrophicPattern('(a|A)+', 'i'), true);
});

function route(...body: string[]) {
  return [
    "import express from 'express';",
    'const app = express();',
    'const emailPattern = /^([a-zA-Z0-9])+@(([a-zA-Z0-9-])+\\.)+([a-zA-Z0-9]{2,4})+$/;',
    "app.get('/search', (req, res) => {",
    ...body,
    '});',
  ].join('\n');
}

function redosLines(source: string) {
  const { typed } = lintBothWays(source, stubs.express);
  return typed
    .filter((finding: LocatedFinding) => finding.ruleId === ruleId)
    .map((finding: LocatedFinding) => finding.line);
}

test('a catastrophic fixed regex run on request text is reported', () => {
  const source = route(
    'emailPattern.test(req.body.email);',
    'const name: string = req.query.name;\nname.match(/^(\\w+\\s?)*$/);',
    "new RegExp('^(a+)+$').exec(req.query.q);",
    "String(req.query.q).replace(/(x+x+)+y/g, '');",
  );
  assert.deepEqual(redosLines(source), [5, 7, 8, 9]);
  assert.equal(
    lintWithoutTypes(source, stubs.express)[0].message,
    'This regular expression can backtrack exponentially on `req.body.email` (ReDoS), blocking the event loop. Rewrite the pattern so no part can match the same text in two ways, or cap the input length first.',
  );
});

test('safe patterns, fixed text, capped polynomial input and runtime-built regexes are silent', () => {
  const source = route(
    '/^[a-z]+(-[a-z]+)*$/.test(req.query.slug);',
    "emailPattern.test('admin@example.com');",
    String.raw`/\s+.*\s+$/.test(req.body.email.slice(0, 254));`,
    "req.query.q.split(',');",
    "new RegExp(String(req.query.flags) === 'x' ? '(a+)+' : 'a').test(req.query.q);",
  );
  assert.deepEqual(redosLines(source), []);
});

test('a length cap does not make an exponential pattern safe', () => {
  const source = route(
    'emailPattern.test(req.body.email.slice(0, 254));',
    "new RegExp('^(a+)+$').exec(String(req.query.q).substring(0, 64));",
  );
  assert.deepEqual(redosLines(source), [5, 6]);
});

test('a cut that can still return long text does not silence a polynomial pattern', () => {
  const source = route(
    String.raw`/\s+.*\s+$/.test(req.body.email.slice(0, -1));`,
    String.raw`/\s+.*\s+$/.test(req.body.email.substring(Number(req.query.at), 254));`,
    String.raw`/\s+.*\s+$/.test(req.body.email.substring(0, 254));`,
  );
  assert.deepEqual(redosLines(source), [5, 6]);
});

test('overlapping unbounded repeats in sequence are polynomial when something after them can fail', () => {
  const polynomialPatterns = [
    String.raw`\s+.*\s+$`,
    String.raw`^\w+[\w-]*$`,
    String.raw`^\w+\s*\w+$`,
    String.raw`^\d+x?\d+$`,
    String.raw`.*\s+,`,
    String.raw`^(?:a+)a+$`,
    String.raw`(?:\d+\d+)x`,
    // ms@0.7.0 (CVE-2015-8315): an optional digit run, an optional dot, then another digit run.
    String.raw`^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$`,
  ];
  for (const pattern of polynomialPatterns) assert.equal(isCatastrophicPattern(pattern), true, pattern);
  assert.equal(isCatastrophicPattern('^a+A+$'), false);
  assert.equal(isCatastrophicPattern('^a+A+$', 'i'), true);
});

test('separated, disjoint, bounded, unfollowed and multi-character repeats are not polynomial', () => {
  const quietPatterns = [
    String.raw`^\d+\.\d+$`,
    String.raw`^\w+_\w+$`,
    String.raw`^[a-z]+\d+$`,
    String.raw`^\s*\w+\s*$`,
    String.raw`^\w{1,64}\w{1,64}$`,
    String.raw`^\w+\w{2}$`,
    String.raw`\d+\w*`,
    String.raw`^\s*.*`,
    String.raw`^(?:ab)+(?:ac)+$`,
    String.raw`^a+\ba+$`,
    String.raw`^(?:\d+)?\.\d+$`,
  ];
  for (const pattern of quietPatterns) assert.equal(isCatastrophicPattern(pattern), false, pattern);
});

// The propagation-only handler regex in lib/accessibility/template-attributes.ts with the call loop
// it had before fc7a5fd (PR #7): each call's trailing `\s*` and the final `\s*` split the spaces in
// `e.stopPropagation()<spaces>|| doSomething()`.
const handlerWithLoopTailRun = String.raw`^\s*(?:(?:\([\w$]*\)|[\w$]+)\s*=>\s*)?(?:\{\s*)?(?:[\w$]+\.(?:stopPropagation|preventDefault)\(\)(?:\s*;)?\s*)+\}?\s*$`;
// The same regex as it was before 3226c7d: `^\s*` and the arrow parameter's `\s*` split leading
// spaces.
const handlerWithLeadingGroupRun = String.raw`^\s*(?:\(?[\w$]*\)?\s*=>\s*)?(?:\{\s*)?(?:[\w$]+\.(?:stopPropagation|preventDefault)\(\)\s*(?:;\s*)?)+(?:\}\s*)?$`;

test('a repeat at the edge of a group or loop overlapping a neighbouring repeat is polynomial', () => {
  const polynomialPatterns = [
    handlerWithLoopTailRun,
    handlerWithLeadingGroupRun,
    String.raw`^(?:x\s*)+\s*$`,
    String.raw`^(?:x\s+)+\}?[ \t]*$`,
    String.raw`^\s*(?:\w*\s*=>)?x$`,
    String.raw`^a*(?:.*b)c$`,
    // `(?:a\s*)+` can take a run of `a`s one per turn, which `\w+` splits with it.
    String.raw`^(?:a\s*)+\w+$`,
    // The `$` that fails sits inside the group.
    String.raw`^a*(?:a+$)`,
  ];
  for (const pattern of polynomialPatterns) assert.equal(isCatastrophicPattern(pattern), true, pattern);
});

test('a repeat inside a `{0}` quantifier never runs, so it overlaps nothing', () => {
  assert.equal(isCatastrophicPattern(String.raw`^\s*(?:\s+){0}x$`), false);
  assert.equal(isCatastrophicPattern(String.raw`^\s*(?:\s+){0,1}x$`), true);
});

test('group edges separated by a required character or over disjoint characters are not polynomial', () => {
  const quietPatterns = [
    // The current propagation-only and empty handler regexes.
    String.raw`^\s*(?:(?:\([\w$]*\)|[\w$]+)\s*=>\s*)?(?:\{\s*)?(?:[\w$]+\.(?:stopPropagation|preventDefault)\(\)\s*(?:;\s*)?)+(?:\}\s*)?$`,
    String.raw`^\s*(?:(?:\([\w$]*\)|[\w$]+)\s*=>\s*)?\{\s*\}\}?\s*$`,
    String.raw`^(?:x\s*)+$`,
    String.raw`^(?:x\s*)+;\s*$`,
    String.raw`^\s*(?:x\s*=>)?y$`,
    String.raw`^(?:\d+,)+\d+$`,
    String.raw`^(?:a\s*)+\d+$`,
    // Nothing after the group's `a+` can fail, so no split is retried.
    String.raw`^a*(?:a+)`,
    // An anchored line ending in `.*$` stays exempt when the anchor or the `.*` sits in a group.
    String.raw`(^[\t ]*).*$`,
    String.raw`^([^/]*)(\/?.*)$`,
  ];
  for (const pattern of quietPatterns) assert.equal(isCatastrophicPattern(pattern), false, pattern);
});

test('a polynomial pattern on request text says it backtracks in polynomial time', () => {
  const findings = lintWithoutTypes(route(String.raw`/^\s+.*\s+$/.test(req.query.q);`), stubs.express);
  assert.deepEqual(
    findings.map((finding: LocatedFinding) => [finding.ruleId, finding.line]),
    [[ruleId, 5]],
  );
  assert.match(findings[0].message, /^This regular expression can backtrack in polynomial time on `req\.query\.q`/);
});

test('a trailing whitespace run without a leading anchor is polynomial', () => {
  for (const pattern of [String.raw`\s+$`, String.raw`^\s*|\s*$`, String.raw`\d+$`])
    assert.equal(isCatastrophicPattern(pattern), true, pattern);
  for (const pattern of [String.raw`^\s+$`, String.raw`^\s*|^\s*$`, String.raw`\s+x$`, String.raw`\s+`])
    assert.equal(isCatastrophicPattern(pattern), false, pattern);
});

test('a polynomial pattern run on a function parameter is contextual, other untraced text is silent', () => {
  const findingsFor = (body: string) =>
    lintWithoutTypes(body, stubs.express).filter((finding: LocatedFinding) => finding.ruleId === ruleId);
  const [finding] = findingsFor(String.raw`export function trim(str) { return str.replace(/^\s*|\s*$/g, ''); }`);
  assert.match(finding.contextualReason ?? '', /function parameter/);
  assert.equal(findingsFor('export function parse(input) { return /^(a+)+$/.exec(String(input)); }').length, 1);
  assert.equal(
    findingsFor(String.raw`export function trim(str) { return str.slice(0, 9).replace(/\s+$/, ''); }`).length,
    0,
  );
  assert.equal(
    findingsFor(String.raw`export function trim() { const text = 'a  '; return text.replace(/\s+$/, ''); }`).length,
    0,
  );
  assert.equal(findingsFor(String.raw`export function trim(str) { return str.replace(/^\s+|\s+$/g, ''); }`).length, 1);
  assert.equal(findingsFor(String.raw`export function trim(str) { return str.replace(/^[a-z]+$/, ''); }`).length, 0);
});
