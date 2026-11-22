'use strict';

// regex-catastrophic-backtracking: a fixed regex with nested or overlapping repetition runs on request text.
// Safe patterns, unparsed patterns, untainted input and length-capped input are silent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintBothWays, lintWithoutTypes, stubs } = require('./helpers.cjs');
const { isCatastrophicPattern } = require('../../lib/security/injection/redos.cjs');

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

// Backreferences, property escapes and malformed text are not modelled, so they are skipped rather than guessed.
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

function route(...body) {
  return [
    "import express from 'express';",
    'const app = express();',
    'const emailPattern = /^([a-zA-Z0-9])+@(([a-zA-Z0-9-])+\\.)+([a-zA-Z0-9]{2,4})+$/;',
    "app.get('/search', (req, res) => {",
    ...body,
    '});',
  ].join('\n');
}

function redosLines(source) {
  const { typed } = lintBothWays(source, stubs.express);
  return typed.filter((finding) => finding.ruleId === ruleId).map((finding) => finding.line);
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

test('safe patterns, fixed text, capped input and runtime-built regexes are silent', () => {
  const source = route(
    '/^[a-z]+(-[a-z]+)*$/.test(req.query.slug);',
    "emailPattern.test('admin@example.com');",
    'emailPattern.test(req.body.email.slice(0, 254));',
    "req.query.q.split(',');",
    "new RegExp(String(req.query.flags) === 'x' ? '(a+)+' : 'a').test(req.query.q);",
  );
  assert.deepEqual(redosLines(source), []);
});
