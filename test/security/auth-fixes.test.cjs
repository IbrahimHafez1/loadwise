'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanWithFixes, onlyChange, withSecurity } = require('../performance/site-fix-helpers.cjs');

function fixesFor(context, ruleId, source, filename = 'app.ts') {
  const { findings } = scanWithFixes(context, { [filename]: source }, { analyzers: withSecurity });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function assertNoFix(context, ruleId, source) {
  const findings = fixesFor(context, ruleId, source);
  assert.ok(findings.length > 0, 'rule should report');
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    findings.map(() => undefined),
  );
}

test('bcrypt-low-cost replaces a literal cost with 12', (context) => {
  const [finding] = fixesFor(
    context,
    'bcrypt-low-cost',
    "import bcrypt from 'bcrypt';\nexport const hash = (password: string) => bcrypt.hash(password, 8);\n",
  );
  assert.deepEqual(onlyChange(finding), {
    before: 'export const hash = (password: string) => bcrypt.hash(password, 8);',
    after: 'export const hash = (password: string) => bcrypt.hash(password, 12);',
  });
});

test('bcrypt-low-cost offers no fix for a constant shared with other code', (context) => {
  assertNoFix(
    context,
    'bcrypt-low-cost',
    "import bcrypt from 'bcrypt';\nconst ROUNDS = 8;\nexport const hash = (password: string) => bcrypt.hash(password, ROUNDS);\n",
  );
});

test('jwt-verify-without-algorithms pins the algorithm the same key signs with', (context) => {
  const source = [
    "import jwt from 'jsonwebtoken';",
    'export const issue = (id: string, secret: string) => jwt.sign({ id }, secret, { expiresIn: 60, algorithm: "HS512" });',
    'export const check = (token: string, secret: string) => jwt.verify(token, secret);',
    '',
  ].join('\n');
  const [finding] = fixesFor(context, 'jwt-verify-without-algorithms', source);
  assert.deepEqual(onlyChange(finding), {
    before: 'export const check = (token: string, secret: string) => jwt.verify(token, secret);',
    after:
      "export const check = (token: string, secret: string) => jwt.verify(token, secret, { algorithms: ['HS512'] });",
  });
});

test('jwt-verify-without-algorithms assumes HS256 when sign names no algorithm and extends existing options', (context) => {
  const source = [
    "import jwt from 'jsonwebtoken';",
    'export const issue = (id: string, secret: string) => jwt.sign({ id }, secret, { expiresIn: 60 });',
    'export const check = (token: string, secret: string) => jwt.verify(token, secret, { audience: "api" });',
    '',
  ].join('\n');
  const [finding] = fixesFor(context, 'jwt-verify-without-algorithms', source);
  assert.deepEqual(onlyChange(finding), {
    before: 'export const check = (token: string, secret: string) => jwt.verify(token, secret, { audience: "api" });',
    after:
      'export const check = (token: string, secret: string) => jwt.verify(token, secret, { audience: "api", algorithms: [\'HS256\'] });',
  });
});

test('jwt-verify-without-algorithms offers no fix when no sign call or conflicting sign calls exist', (context) => {
  assertNoFix(
    context,
    'jwt-verify-without-algorithms',
    "import jwt from 'jsonwebtoken';\nexport const check = (token: string, secret: string) => jwt.verify(token, secret);\n",
  );
  assertNoFix(
    context,
    'jwt-verify-without-algorithms',
    [
      "import jwt from 'jsonwebtoken';",
      'export const a = (secret: string) => jwt.sign({}, secret, { algorithm: "HS256", expiresIn: 1 });',
      'export const b = (secret: string) => jwt.sign({}, secret, { algorithm: "HS512", expiresIn: 1 });',
      'export const check = (token: string, secret: string) => jwt.verify(token, secret);',
      '',
    ].join('\n'),
  );
});

test('insecure-random-for-secret rewrites Math.floor(Math.random() * N) to randomInt(N) and adds the import', (context) => {
  const source = [
    "import { readFileSync } from 'node:fs';",
    'export const resetPin = () => Math.floor(Math.random() * 10000);',
    '',
  ].join('\n');
  const [finding] = fixesFor(context, 'insecure-random-for-secret', source);
  assert.deepEqual(onlyChange(finding), {
    before: [
      "import { readFileSync } from 'node:fs';",
      'export const resetPin = () => Math.floor(Math.random() * 10000);',
    ].join('\n'),
    after: [
      "import { readFileSync } from 'node:fs';",
      "import { randomInt } from 'node:crypto';",
      'export const resetPin = () => randomInt(10000);',
    ].join('\n'),
  });
});

test('insecure-random-for-secret offers no fix for other shapes or files without imports', (context) => {
  assertNoFix(
    context,
    'insecure-random-for-secret',
    "import fs from 'node:fs';\nexport const resetToken = () => Math.random().toString(36);\n",
  );
  assertNoFix(
    context,
    'insecure-random-for-secret',
    'export const resetPin = () => Math.floor(Math.random() * 10000);\n',
  );
});
