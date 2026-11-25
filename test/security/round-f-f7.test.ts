import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.js';
import { buildFix, fixedRegexLiteral } from '../../lib/security/exposure/cors-origin-regex.js';

const ruleId = 'cors-origin-regex-unanchored';
const corsImport = "import cors from 'cors';\ndeclare const app: any;\n";

test('credentialed CORS origin regexes that a look-alike host passes are reported', () => {
  const origins = [
    String.raw`/example\.com$/`,
    String.raw`/https:\/\/app.example.com/`,
    String.raw`/^https:\/\/app\.example\.com/`,
    String.raw`/^https:\/\/.*example\.com$/`,
    String.raw`[/https:\/\/app\.example\.com/, 'https://b.example.com']`,
    String.raw`/^https:\/\/a\.example\.com$|b\.example\.com$/`,
  ];
  for (const origin of origins) {
    const source = `${corsImport}app.use(cors({ origin: ${origin}, credentials: true }));`;
    assert.equal(defaultFindingsOf(ruleId, source).length, 1, origin);
  }
});

test('anchored, subdomain-bounded and host-free origin regexes are clean', () => {
  const origins = [
    String.raw`/^https:\/\/app\.example\.com$/`,
    String.raw`/\.example\.com$/`,
    String.raw`/^https:\/\/(.*\.)?example\.com$/`,
    String.raw`/^https:\/\/([\w-]+\.)*example\.com(:\d+)?$/`,
    String.raw`/^http:\/\/localhost:\d+$/`,
    String.raw`/.*/`,
    "'https://app.example.com'",
  ];
  for (const origin of origins) {
    const source = `${corsImport}app.use(cors({ origin: ${origin}, credentials: true }));`;
    assert.equal(findingsOf(ruleId, source).length, 0, origin);
  }
});

test('without credentials the finding is contextual', () => {
  const source = `${corsImport}app.use(cors({ origin: /example\\.com$/ }));`;
  assert.equal(findingsOf(ruleId, source).length, 1);
  assert.equal(defaultFindingsOf(ruleId, source).length, 0);
});

test('regex tests on the request origin in callbacks and handlers are reported', () => {
  const sources = [
    `${corsImport}app.use(cors({ origin: (origin, done) => done(null, /example\\.com$/.test(origin)), credentials: true }));`,
    `const allowed = /https:\\/\\/app.example.com/;\nexport function check(req: any) { return allowed.test(req.headers.origin); }`,
    `const ALLOWED = new RegExp(process.env.FRONT_BASE_URL || '');\nexport function check(requestOrigin: string) { return ALLOWED.test(requestOrigin); }`,
  ];
  for (const source of sources) assert.equal(defaultFindingsOf(ruleId, source).length, 1, source);
});

test('safe tests, other values and regexes meant as patterns are clean', () => {
  const sources = [
    `export function check(origin: string) { return /^https:\\/\\/app\\.example\\.com$/.test(origin); }`,
    `export function check(path: string) { return /example\\.com$/.test(path); }`,
    `const owner = { origin: { owner: '' } };\n/Base$/.test(owner.origin.owner);`,
    `const ALLOWED = new RegExp(process.env.CORS_ORIGIN_REGEX);\nexport function check(origin: string) { return ALLOWED.test(origin); }`,
    `declare function escape(s: string): string;\nconst ALLOWED = new RegExp(escape(process.env.URL));\nexport function check(origin: string) { return ALLOWED.test(origin); }`,
  ];
  for (const source of sources) assert.equal(findingsOf(ruleId, source).length, 0, source);
});

test('the fix anchors and escapes when the intent has one reading', () => {
  const cases: [string, string | undefined][] = [
    [String.raw`/example\.com$/`, String.raw`/(?:\/\/|\.)example\.com$/`],
    [String.raw`/https:\/\/app.example.com/`, String.raw`/https:\/\/app\.example\.com$/`],
    [String.raw`/^https:\/\/app\.example\.com(:\d+)?/i`, String.raw`/^https:\/\/app\.example\.com(:\d+)?$/i`],
    [String.raw`/^https:\/\/.*example\.com$/`, undefined],
    [String.raw`/a\.example\.com$|b\.example\.com$/`, undefined],
    [String.raw`/^https:\/\/app\.example\.com.*/`, undefined],
  ];
  for (const [before, after] of cases) assert.equal(fixedRegexLiteral(before), after, before);
});

test('the site-fix builder replaces the literal and asks for review', () => {
  const text = 'const allowed = /example\\.com$/;';
  const sourceFile = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true);
  const [statement] = sourceFile.statements;
  assert.ok(statement && ts.isVariableStatement(statement));
  const literal = statement.declarationList.declarations[0]?.initializer;
  const fix = buildFix({ finding: { ruleId, message: '' }, node: literal, sourceFile, load: () => null });
  assert.ok(fix);
  assert.equal(fix.requiresReview, true);
  assert.deepEqual(fix.edits, [{ start: 16, end: 31, text: String.raw`/(?:\/\/|\.)example\.com$/` }]);
});
