'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const ts = require('typescript');
const { scanWithFixes, onlyChange, withSecurity } = require('../performance/site-fix-helpers.cjs');
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
  assert.equal((rewritten.match(/from 'node:crypto'/g) ?? []).length, 1);
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
