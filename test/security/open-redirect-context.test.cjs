'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintBothWays, stubs } = require('./helpers.cjs');

const ruleId = 'open-redirect';

function findings(handlerBody, preamble = '') {
  const source = [
    "import express from 'express';",
    preamble,
    'const app = express();',
    `app.get('/go', (req, res) => { ${handlerBody} });`,
  ].join('\n');
  return lintBothWays(source, stubs.express).typed.filter((finding) => finding.ruleId === ruleId);
}

test('a target that is the request own path is contextual, not silent', () => {
  const [finding] = findings("const next = req.path.replace(/^\\/old/, '/new'); res.redirect(next);");
  assert.ok(finding);
  assert.match(finding.contextualReason, /request's own path/);
});

test('a template that opens with a constant string keeps the site fixed', () => {
  const preamble =
    "const MOBILE_REDIRECT = 'app.example:///oauth';\nconst build = (url: string) => `${MOBILE_REDIRECT}?${url}`;";
  assert.equal(findings('res.redirect(build(req.url));', preamble).length, 0);
});

test('a relative literal prefix keeps the site fixed', () => {
  assert.equal(findings("res.redirect('original?' + String(req.query.q));").length, 0);
});

test('a target passed to a validator named like isSiteUrl or isValidReturnTo is contextual', () => {
  const preamble =
    'declare function isSiteUrl(url: string): boolean;\ndeclare function isValidReturnTo(url: string): boolean;';
  const [site] = findings('const next = req.query.r as string; if (isSiteUrl(next)) { res.redirect(next); }', preamble);
  assert.match(site.contextualReason, /validation helper/);
  const [returnTo] = findings(
    'let next = req.query.r as string; next = isValidReturnTo(next) ? next : "/"; res.redirect(next);',
    preamble,
  );
  assert.match(returnTo.contextualReason, /validation helper/);
});

test('a target assigned from a validating call is contextual', () => {
  const preamble =
    'const getValidatedCallbackUrl = (url: string, base: string) => (url.startsWith(base) ? url : undefined);';
  const [finding] = findings(
    "const checked = getValidatedCallbackUrl(req.query.cb as string, 'https://app.example'); res.redirect(checked ?? '/');",
    preamble,
  );
  assert.match(finding.contextualReason, /validation helper/);
});

test('an allowlist built on a substring check is still reported without a reason', () => {
  const preamble = [
    "const allowlist = ['https://allowed.example'];",
    'const isRedirectAllowed = (url: string) => { let allowed = false; for (const item of allowlist) { allowed = allowed || url.includes(item); } return allowed; };',
  ].join('\n');
  const [finding] = findings(
    'const to = req.query.to as string; if (isRedirectAllowed(to)) { res.redirect(to); }',
    preamble,
  );
  assert.ok(finding);
  assert.equal(finding.contextualReason, undefined);
});

test('a plain request-controlled target is still reported without a reason', () => {
  const [finding] = findings('res.redirect(req.query.url as string);');
  assert.ok(finding);
  assert.equal(finding.contextualReason, undefined);
});
