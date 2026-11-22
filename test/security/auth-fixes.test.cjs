'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const ts = require('typescript');
const {
  assertReportedWithoutFix,
  scanWithFixes,
  onlyChange,
  withSecurity,
} = require('../performance/site-fix-helpers.cjs');
const { stubs } = require('./helpers.cjs');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const comparisonRule = 'secret-compared-non-constant-time';
const expressPackage = {
  ...stubs.express,
  'node_modules/express/package.json': '{"types":"./index.d.ts"}',
};

function fixesFor(context, ruleId, source, filename = 'app.ts') {
  const { findings } = scanWithFixes(context, { [filename]: source }, { analyzers: withSecurity });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function assertNoFix(context, ruleId, source) {
  assertReportedWithoutFix(fixesFor(context, ruleId, source));
}

test('database TLS literal opt-outs have a reviewed edit; type assertions stay manual', (context) => {
  const findings = fixesFor(
    context,
    'tls-verification-disabled',
    [
      "const enabled = process.env.DB_SSL === 'true';",
      'export const config = { ssl: enabled ? { rejectUnauthorized: (false as const) } : false };',
      'export function options(value: string) {',
      "  if (value === 'true') return { rejectUnauthorized: false };",
      '  return { rejectUnauthorized: true };',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ line }) => line),
    [2, 4],
  );
  for (const finding of findings) {
    assert.equal(finding.contextualReason, undefined);
    assert.match(finding.message, /trusted CA/);
  }
  assert.equal(findings[0].fix, undefined);
  assert.equal(findings[1].fix.requiresReview, true);
  assert.match(findings[1].fix.changes[0].after, /rejectUnauthorized: true/);
});

test('mysql2 TLS options check hostname verification for the installed driver', (context) => {
  const source = [
    "const mysql = require('mysql2/promise');",
    "mysql.createConnection({ ssl: process.env.DB_SSL === 'true' ? {} : undefined });",
    "mysql.createPool({ ssl: { ca: 'private CA' } });",
    'mysql.createConnection({ ssl: { verifyIdentity: false } });',
    'mysql.createPool({ ssl: { rejectUnauthorized: false } });',
    'mysql.createPool({ ssl: { rejectUnauthorized: true, verifyIdentity: true } });',
    'mysql.createPool({ ssl: { ...settings } });',
    'mysql.createPool({ ssl: { [option]: true } });',
    'mysql.createPool({ ssl: {}, ...settings });',
    "require('other-db').createPool({ ssl: {} });",
    'mysql.createPool({});',
    'mysql.createPool({ ssl: { verifyIdentity } });',
    'mysql.createPool({ ssl: { get verifyIdentity() { return true; } } });',
    'mysql.extension().createPool({ ssl: {} });',
  ].join('\n');
  for (const version of ['3.16.0', '4.0.0']) {
    const { findings } = scanWithFixes(
      context,
      {
        'migration.js': source,
        'node_modules/mysql2/package.json': JSON.stringify({ name: 'mysql2', version }),
      },
      { analyzers: withSecurity },
    );
    const tls = findings.filter(({ ruleId }) => ruleId === 'tls-verification-disabled');
    assert.deepEqual(
      tls.map(({ line }) => line),
      version === '3.16.0' ? [2, 3, 4, 5] : [4, 5],
    );
    assert.ok(tls.filter(({ line }) => line < 4).every(({ fix }) => fix === undefined));
    assert.ok(tls.filter(({ line }) => line >= 4).every(({ fix }) => fix?.requiresReview));
    assert.match(tls[0].message, /hostname/);
  }
});

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
  assert.equal(finding.fix.requiresReview, true);
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

test('JWT algorithm hints require a matching receiver and key expression and an unambiguous signed algorithm', (context) => {
  const signers = [
    'other.sign({}, settings.secret, {})',
    'jwt.sign({}, alternate.secret, {})',
    'jwt.sign({}, settings.secret, { ...options })',
    'jwt.sign({}, settings.secret, { algorithm })',
    'jwt.sign({}, settings.secret, { header: options })',
    'jwt.sign({}, settings.secret, { algorithm: "none" })',
  ];
  for (const signer of signers)
    assertNoFix(
      context,
      'jwt-verify-without-algorithms',
      [
        "import jwt from 'jsonwebtoken';",
        'declare const settings: any, alternate: any, other: any, algorithm: any, options: any;',
        'export const issue = () => ' + signer + ';',
        'export const check = (token: string) => jwt.verify(token, settings.secret);',
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

test('the security CLI fixes both strict string comparisons and preserves their results and evaluation order', (context) => {
  const source = [
    "import { deepEqual } from 'node:assert/strict';",
    "import type { Request } from 'express';",
    'function equal(req: Request, stored: { secret: string }) { return req.headers.signature === stored.secret; }',
    'function different(req: Request, stored: { secret: string }) { return stored.secret !== req.headers.signature; }',
    'const pairs = [["equal", "equal"], ["a", "b"], ["a", "longer"], ["\\uD800", "\\uFFFD"], [null, null], ["1", 1]];',
    'for (const [supplied, expected] of pairs) {',
    '  const reads: string[] = [];',
    '  const req = { get headers() { reads.push("request"); return { signature: supplied }; } } as Request;',
    '  const stored = { get secret() { reads.push("stored"); return expected; } } as { secret: string };',
    '  console.log(JSON.stringify([equal(req, stored), different(req, stored)]));',
    '  deepEqual(reads, ["request", "stored", "stored", "request"]);',
    '}',
  ].join('\n');
  const { root } = scanWithFixes(context, { 'app.mts': source, ...expressPackage }, { analyzers: withSecurity });
  const run = (...args) =>
    spawnSync(process.execPath, [cli, 'sec', 'app.mts', '--json', ...args], { cwd: root, encoding: 'utf8' });
  const filename = path.join(root, 'app.mts');
  const execute = () => {
    const input = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input, encoding: 'utf8' });
  };
  const before = execute();
  const report = run();
  assert.equal(report.status, 1, report.stderr);
  const findings = JSON.parse(report.stdout).findings.filter(({ ruleId }) => ruleId === comparisonRule);
  assert.equal(findings.length, 2);
  assert.ok(
    findings.every(({ fixable }) => fixable),
    'both type-proven comparisons have a fix',
  );
  const ids = findings.map(({ id }) => id);
  const fixed = run('--fix', '--only', ids.join(','));
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.deepEqual(JSON.parse(fixed.stdout).applied, ids);
  const rewritten = fs.readFileSync(filename, 'utf8');
  assert.match(rewritten, /timingSafeEqual/);
  assert.equal((rewritten.match(/from "node:crypto"/g) ?? []).length, 1);
  assert.equal(execute(), before);
  assert.ok(JSON.parse(run().stdout).findings.every(({ ruleId }) => ruleId !== comparisonRule));
});

test('the timing-safe fix leaves loose equality, unproven operands, and runtime ambiguity for manual review', (context) => {
  const source = [
    "import 'node:crypto';",
    "import type { Request } from 'express';",
    'function loose(req: Request, secret: string) { return req.headers.signature == secret; }',
    'function coercion(req: Request, secret: string) { return req.body.signature === secret; }',
    'function mixed(req: Request, secret: string | undefined) { return req.headers.signature === secret; }',
  ].join('\n');
  const typeOnlySource = [
    "import { type IncomingMessage } from 'node:http';",
    "import type { Request } from 'express';",
    'function compare(req: Request, secret: string) { return req.headers.signature === secret; }',
  ].join('\n');
  const { root } = scanWithFixes(
    context,
    { 'app.mts': source, 'type-only.mts': typeOnlySource, ...expressPackage },
    { analyzers: withSecurity },
  );
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true},"files":["app.mts","type-only.mts"]}',
  );
  const report = spawnSync(process.execPath, [cli, 'sec', '-p', 'tsconfig.json', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(report.status, 1, report.stderr);
  const comparisons = JSON.parse(report.stdout).findings.filter(({ ruleId }) => ruleId === comparisonRule);
  assert.equal(comparisons.length, 4);
  assert.ok(comparisons.every(({ fixable }) => !fixable));
  assert.equal(fs.readFileSync(path.join(root, 'app.mts'), 'utf8'), source);
});
