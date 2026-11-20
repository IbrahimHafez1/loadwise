'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint, lintBothWays, stubs } = require('./helpers.cjs');

function summary(findings, ruleId) {
  return findings
    .filter((finding) => finding.ruleId === ruleId)
    .map((finding) => [finding.line, Boolean(finding.contextualReason)]);
}

function lines(findings, ruleId) {
  return summary(findings, ruleId).map(([line]) => line);
}

test('secret-compared-non-constant-time reports digests and secret-named values compared with request input', () => {
  const source = [
    "import express from 'express';",
    "import { createHmac, createHash } from 'node:crypto';",
    'const app = express();',
    "app.post('/hook', (req, res) => {",
    "  const expected = createHmac('sha256', process.env.HOOK_KEY!).update(req.body.raw).digest('hex');",
    "  if (expected !== req.headers['x-signature']) return res.send('no');",
    "  if (createHash('sha256').update('a').digest('hex') === req.query.hash) return res.send('hash');",
    '  const stored = { apiKey: process.env.API_KEY, resetToken: process.env.RESET };',
    "  if (req.headers['x-api-key'] === stored.apiKey) return res.send('key');",
    "  if (req.body.otp === stored.resetToken) return res.send('reset');",
    '});',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source, stubs.express);
  assert.deepEqual(lines(typed, 'secret-compared-non-constant-time'), [6, 7, 9, 10]);
  assert.deepEqual(
    summary(untyped, 'secret-compared-non-constant-time'),
    summary(typed, 'secret-compared-non-constant-time'),
  );
});

test('secret-compared-non-constant-time ignores literals, enum members, untraced pairs, both-traced pairs and length reads', () => {
  const findings = lint(
    [
      "import express from 'express';",
      'const app = express();',
      'declare const stored: { token: string; password: string };',
      'declare const TokenKind: { Access: string };',
      "app.post('/login', (req, res) => {",
      "  if (req.body.password === '') return;",
      '  if (req.body.token === undefined) return;',
      '  if (req.body.token.length === stored.token.length) return;',
      '  if (req.body.password !== req.body.confirmPassword) return;',
      '  if (stored.password === stored.token) return;',
      '  if (req.body.kind === TokenKind.Access) return;',
      '  if (typeof req.body.token === "string") return;',
      '  res.send("ok");',
      '});',
    ].join('\n'),
    stubs.express,
  );
  assert.deepEqual(summary(findings, 'secret-compared-non-constant-time'), []);
});

test('secret-compared-non-constant-time is contextual for a bare token name', () => {
  const findings = lint(
    [
      "import express from 'express';",
      'const app = express();',
      'declare const device: { token: string };',
      "app.post('/device', (req, res) => { if (req.body.token !== device.token) res.send('changed'); });",
    ].join('\n'),
    stubs.express,
  );
  assert.deepEqual(summary(findings, 'secret-compared-non-constant-time'), [[4, true]]);
});

test('insecure-random-for-secret reports Math.random flowing into tokens, codes and secrets', () => {
  const source = [
    'export function make() {',
    '  const resetToken = Math.random().toString(36).slice(2);',
    '  const temp = Math.random().toString(36);',
    '  const session = { sessionKey: temp, expires: 1 };',
    '  const otp = Math.floor(100000 + Math.random() * 900000);',
    '  const code = `${Math.random()}`;',
    '  return { resetToken, session, otp, code, csrf: Math.random() };',
    '}',
    'export const generateInviteCode = () => Math.random().toString(16).substring(2, 10);',
    'export function newPin() { return Math.floor(Math.random() * 10000); }',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source);
  assert.deepEqual(lines(typed, 'insecure-random-for-secret'), [2, 3, 5, 7, 9, 10]);
  assert.deepEqual(summary(untyped, 'insecure-random-for-secret'), summary(typed, 'insecure-random-for-secret'));
});

test('insecure-random-for-secret is contextual for plain identifiers and silent for non-secret names', () => {
  const findings = lint(
    [
      'declare const items: string[];',
      'export function make() {',
      '  const requestId = Math.random().toString(36).slice(2);',
      '  const retryDelay = Math.random() * 1000;',
      '  const color = Math.floor(Math.random() * 255);',
      '  const shipping = Math.random();',
      '  const mapping = Math.floor(Math.random() * 3);',
      '  const jitter = { tokenBucket: 1, jitterMs: Math.random() };',
      '  const pick = items[Math.floor(Math.random() * items.length)];',
      '  return { requestId, retryDelay, color, shipping, mapping, jitter, pick };',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(summary(findings, 'insecure-random-for-secret'), [[3, true]]);
});

test('weak-password-hash reports fast hashes of passwords and digests stored as passwords', () => {
  const source = [
    "import crypto from 'crypto';",
    "import CryptoJS from 'crypto-js';",
    "import md5 from 'md5';",
    'export function hashes(password: string, input: string) {',
    "  const a = crypto.createHash('md5').update(password).digest('hex');",
    "  const hashedPassword = crypto.createHash('sha256').update(input + 'salt').digest('hex');",
    '  const b = CryptoJS.SHA1(password).toString();',
    '  const c = md5(password);',
    "  return { a, hashedPassword, b, c, passwordHash: crypto.createHash('sha512').update(input).digest('hex') };",
    '}',
    'export function hashPassword(value: string) {',
    "  return crypto.createHash('sha1').update(value).digest('hex');",
    '}',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source);
  assert.deepEqual(lines(typed, 'weak-password-hash'), [5, 6, 7, 8, 9, 12]);
  assert.deepEqual(summary(untyped, 'weak-password-hash'), summary(typed, 'weak-password-hash'));
});

test('weak-password-hash is silent for cache keys, reset tokens, HMACs, bcrypt pre-hashes and constant-time comparisons', () => {
  const findings = lint(
    [
      "import crypto, { createHash, createHmac, timingSafeEqual } from 'crypto';",
      "import bcrypt from 'bcrypt';",
      'export async function others(password: string, url: string, email: string, resetToken: string, given: Buffer) {',
      "  const etag = crypto.createHash('md5').update(url).digest('hex');",
      "  const gravatar = createHash('md5').update(email.trim().toLowerCase()).digest('hex');",
      "  const passwordResetToken = createHash('sha256').update(resetToken).digest('hex');",
      "  const keyed = createHmac('sha256', 'k').update(password).digest('hex');",
      "  const stored = await bcrypt.hash(createHash('sha256').update(password).digest('base64'), 12);",
      "  const expected = createHash('sha256').update(password).digest();",
      '  timingSafeEqual(expected, given);',
      "  const strong = createHash('sha3-512').update(password).digest('hex');",
      '  return { etag, gravatar, passwordResetToken, keyed, stored, strong };',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(summary(findings, 'weak-password-hash'), []);
});

test('bcrypt-low-cost reports literal costs below 10, directly or through a const', () => {
  const source = [
    "import bcrypt from 'bcryptjs';",
    'const ROUNDS = 8;',
    'export async function hash(password: string) {',
    '  await bcrypt.hash(password, 4);',
    '  bcrypt.hashSync(password, ROUNDS);',
    '  await bcrypt.genSalt(9);',
    '  bcrypt.genSaltSync(1);',
    '  await bcrypt.hash(password, 10);',
    '  await bcrypt.hash(password, 12);',
    '}',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source);
  assert.deepEqual(lines(typed, 'bcrypt-low-cost'), [4, 5, 6, 7]);
  assert.deepEqual(summary(untyped, 'bcrypt-low-cost'), summary(typed, 'bcrypt-low-cost'));
});

test('bcrypt-low-cost checks the non-test branch and ignores unknown costs and other libraries', () => {
  const findings = lint(
    [
      "import { hash } from 'bcrypt';",
      "import other from 'argon-like';",
      'declare const config: { rounds: number };',
      "const rounds = process.env.NODE_ENV === 'test' ? 4 : 12;",
      "const weakOutsideTest = process.env.NODE_ENV === 'test' ? 12 : 6;",
      'export async function run(password: string) {',
      '  await hash(password, rounds);',
      '  await hash(password, weakOutsideTest);',
      '  await hash(password, config.rounds);',
      '  await hash(password, 5 + 6);',
      "  await hash(password, 'a-salt-string');",
      '  await other.hash(password, 2);',
      "  if (process.env.NODE_ENV === 'test') await hash(password, 1);",
      '}',
    ].join('\n'),
  );
  assert.deepEqual(summary(findings, 'bcrypt-low-cost'), [[8, false]]);
});

test('insecure-cipher reports createCipher, broken algorithms, ECB and fixed IVs', () => {
  const source = [
    "import crypto, { createCipheriv } from 'node:crypto';",
    "const iv = Buffer.from('0102030405060708', 'hex');",
    'export function run(key: Buffer, secret: string) {',
    '  crypto.createCipher("aes192", secret);',
    '  crypto.createDecipher("aes192", secret);',
    '  createCipheriv("des-ede3-cbc", key, crypto.randomBytes(8));',
    '  createCipheriv("aes-128-ecb", key, null);',
    '  createCipheriv("aes-256-cbc", key, Buffer.alloc(16, 0));',
    '  createCipheriv("aes-256-cbc", key, iv);',
    '  createCipheriv("aes-256-cbc", key, "0123456789abcdef");',
    '}',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source);
  assert.deepEqual(lines(typed, 'insecure-cipher'), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(summary(untyped, 'insecure-cipher'), summary(typed, 'insecure-cipher'));
  const messages = typed.filter((finding) => finding.ruleId === 'insecure-cipher').map((finding) => finding.message);
  assert.match(messages[3], /ECB mode/);
  assert.match(messages[4], /fixed IV/);
});

test('insecure-cipher is silent for authenticated modes with random IVs', () => {
  const findings = lint(
    [
      "import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';",
      'export function run(key: Buffer, stored: Buffer) {',
      "  createCipheriv('aes-256-gcm', key, randomBytes(12));",
      "  createCipheriv('aes-256-cbc', key, randomBytes(16));",
      "  createDecipheriv('aes-256-gcm', key, stored.subarray(0, 12));",
      "  createCipheriv('chacha20-poly1305', key, Buffer.from(process.env.NONCE ?? '', 'hex'));",
      '}',
    ].join('\n'),
  );
  assert.deepEqual(summary(findings, 'insecure-cipher'), []);
});

test('tls-verification-disabled reports literal overrides and demotes non-production guards', () => {
  const source = [
    "import https from 'node:https';",
    'declare const isDev: boolean;',
    'export const agent = new https.Agent({ rejectUnauthorized: false });',
    'export const options = { strictSSL: false, "rejectUnauthorized": false };',
    "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';",
    "process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';",
    "if (process.env.NODE_ENV !== 'production') { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; }",
    'export const flagged = isDev ? { rejectUnauthorized: false } : {};',
  ].join('\n');
  assert.deepEqual(summary(lint(source), 'tls-verification-disabled'), [
    [3, false],
    [4, false],
    [4, false],
    [5, false],
    [6, false],
    [7, true],
    [8, true],
  ]);
});

test('tls-verification-disabled is silent for verification on, expressions and unrelated variables', () => {
  const findings = lint(
    [
      'declare const allow: boolean;',
      'export const a = { rejectUnauthorized: true };',
      'export const b = { rejectUnauthorized: allow };',
      'export const c = { rejectUnauthorized: !allow };',
      "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';",
      "process.env.OTHER_SETTING = '0';",
      'export const d = { strictSSL: true, ssl: false };',
    ].join('\n'),
  );
  assert.deepEqual(summary(findings, 'tls-verification-disabled'), []);
});
