'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf, defaultFindingsOf } = require('./exposure-helpers.cjs');

const ruleId = 'cookie-missing-security-flags';
const handler = (body) =>
  `declare const token: string; declare const isProduction: boolean; declare const cookies: any;\nexport function login(req: any, res: any, reply: any, ctx: any) { ${body} }`;

test('a session or token cookie without httpOnly, or with a false literal, is reported by default', () => {
  const bodies = [
    "res.cookie('session', token);",
    "res.cookie('sid', token, { maxAge: 1000 });",
    "res.cookie('auth', token, { httpOnly: false });",
    "res.cookie('refreshToken', token, { httpOnly: true, secure: false });",
    "res.status(200).cookie('jwt', token, { secure: true });",
    "reply.setCookie('access_token', token, { path: '/' });",
    "ctx.cookies.set('session', token, { httpOnly: false });",
    "res.cookie('theme', token, { secure: true });",
  ];
  for (const body of bodies) assert.equal(defaultFindingsOf(ruleId, handler(body)).length, 1, body);
});

test('the message names what is missing', () => {
  const [finding] = findingsOf(ruleId, handler("res.cookie('session', token, { sameSite: 'lax' });"));
  assert.match(finding.message, /without httpOnly, secure\./);
});

test('only a missing secure or sameSite is contextual', () => {
  const contextual = [
    "res.cookie('session', token, { httpOnly: true });",
    "res.cookie('session', token, { httpOnly: true, secure: isProduction });",
    "ctx.cookies.set('session', token, { secure: true });",
  ];
  for (const body of contextual) {
    const findings = findingsOf(ruleId, handler(body));
    assert.equal(findings.length, 1, body);
    assert.ok(findings[0].contextualReason, body);
  }
});

test('session middleware options are checked', () => {
  const sessionImport = "import session from 'express-session';\ndeclare const app: any;\n";
  const secure = `${sessionImport}app.use(session({ cookie: { secure: false, sameSite: 'lax' } }));`;
  assert.equal(defaultFindingsOf(ruleId, secure).length, 1);
  const httpOnly = `${sessionImport}app.use(session({ cookie: { httpOnly: false, secure: true, sameSite: 'lax' } }));`;
  assert.equal(defaultFindingsOf(ruleId, httpOnly).length, 1);
  const cookieSession =
    "import cookieSession from 'cookie-session';\ndeclare const app: any;\napp.use(cookieSession({ name: 'session', secure: false }));";
  assert.equal(defaultFindingsOf(ruleId, cookieSession).length, 1);
});

test('cookie.serialize is checked', () => {
  const source =
    "import { serialize } from 'cookie';\ndeclare const token: string;\nserialize('session', token, { path: '/' });";
  assert.equal(defaultFindingsOf(ruleId, source).length, 1);
});

test('complete flags, other cookie names, non-literal options and script-readable cookies are clean', () => {
  const clean = [
    "res.cookie('session', token, { httpOnly: true, secure: true, sameSite: 'lax' });",
    "res.cookie('session', token, { httpOnly: true, secure: isProduction, sameSite: 'strict' });",
    "res.cookie('theme', 'dark');",
    "res.cookie('locale', 'en', { httpOnly: false });",
    "res.cookie('session', token, options);",
    "res.cookie('session', token, { ...base });",
    "res.cookie('XSRF-TOKEN', token, { secure: true, sameSite: 'lax' });",
    "res.clearCookie('session');",
    "ctx.cookies.set('session', token, { secure: true, sameSite: 'lax' });",
    "cookies.set('session', token);",
  ];
  for (const body of clean) {
    const source = `${handler(body)}\ndeclare const options: object; declare const base: object;`;
    assert.equal(defaultFindingsOf(ruleId, source).length, 0, body);
  }
  const session =
    "import session from 'express-session';\ndeclare const app: any;\napp.use(session({ secret: 'x', cookie: { httpOnly: true, secure: true, sameSite: 'lax' } }));";
  assert.equal(findingsOf(ruleId, session).length, 0);
  const noCookieOptions =
    "import session from 'express-session';\ndeclare const app: any;\napp.use(session({ secret: 'x' }));";
  assert.equal(findingsOf(ruleId, noCookieOptions).length, 0);
});
