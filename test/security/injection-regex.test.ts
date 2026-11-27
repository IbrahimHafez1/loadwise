// regex-from-input: request text compiled as a pattern by RegExp, string pattern methods or
// `$regex`. Escaped input, literal patterns, non-string receivers and RE2 are silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintBothWays, lintWithoutTypes, stubs } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const ruleId = 'regex-from-input';

function route(...body: string[]) {
  return [
    "import express from 'express';",
    'declare const users: { find(filter: object): unknown };',
    'declare const RE2: new (pattern: string) => RegExp;',
    'declare function escapeRegExp(text: string): string;',
    'const app = express();',
    "app.get('/search', (req, res) => {",
    ...body,
    '});',
  ].join('\n');
}

function regexLines(source: string) {
  const { typed } = lintBothWays(source, stubs.express);
  return typed.filter((finding: Finding) => finding.ruleId === ruleId).map((finding: Finding) => finding.line);
}

test('request text compiled by RegExp, string pattern methods and $regex is reported', () => {
  const source = route(
    "const pattern = new RegExp(req.query.q, 'i');",
    'const term = req.body.term;',
    'RegExp(`^${term}`);',
    "'title'.match(req.body.term);",
    "const title: string = 'x';\ntitle.search(req.body.term);",
    "users.find({ name: { $regex: req.query.q, $options: 'i' } });",
  );
  assert.deepEqual(regexLines(source), [7, 9, 10, 12, 13]);
  assert.equal(
    lintWithoutTypes(source, stubs.express)[0].message,
    'This regular expression is built from `req.query.q`; a crafted pattern can block the event loop (ReDoS) or match more than intended. Escape the input before building the pattern or use a literal comparison.',
  );
});

test('escaped input, literal patterns, RE2 and non-string receivers are silent', () => {
  const source = route(
    "const escaped = req.query.q.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
    "new RegExp(escaped, 'i');",
    'new RegExp(escapeRegExp(req.query.q));',
    "new RegExp('^[a-z]+$').test(req.query.q);",
    'new RE2(req.query.q);',
    'const router = { match(path: string) {} };\nrouter.match(req.body.path);',
    "users.find({ name: { $regex: '^admin' } });",
  );
  assert.deepEqual(regexLines(source), []);
});

test('a request value reaching a search helper is reported in the helper', () => {
  const source = [
    "import express from 'express';",
    "function matcher(term: string) { return new RegExp(term, 'i'); }",
    'const app = express();',
    "app.get('/x', (req, res) => res.send(matcher(req.query.q)));",
  ].join('\n');
  assert.deepEqual(regexLines(source), [2]);
});

test('bracket-notation calls, string | RegExp patterns and computed $regex keys are reported', () => {
  const source = route(
    "const title: string = 'x';",
    "title['search'](req.body.term);",
    'const pattern: string | RegExp = req.query.q;',
    "'title'.search(pattern);",
    "users.find({ name: { ['$regex']: req.query.q } });",
    'const known: RegExp = /a/;',
    "'title'.search(known);",
  );
  assert.deepEqual(regexLines(source), [8, 10, 11]);
});
