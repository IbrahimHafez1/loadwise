'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintBothWays, lintWithoutTypes, stubs } = require('./helpers.cjs');

function redirectRoute(helpers, body) {
  return [
    "import express from 'express';",
    helpers,
    'const app = express();',
    `app.get('/login', (req, res) => { ${body} });`,
  ].join('\n');
}

function fileRoute(helpers, body) {
  return [
    "import express from 'express';",
    "import path from 'path';",
    "import { readFile } from 'fs/promises';",
    helpers,
    'const app = express();',
    `app.get('/files', async (req, res) => { ${body} });`,
  ].join('\n');
}

function findings(source, ruleId) {
  return lintBothWays(source, stubs.express).typed.filter((finding) => finding.ruleId === ruleId);
}

const relativeCheck = [
  "const ALLOWED = ['/home', '/account'];",
  'function isLocal(target: string) { return ALLOWED.includes(target); }',
  "function assertLocal(target: string) { if (!ALLOWED.includes(target)) throw new Error('bad'); }",
  "function localOrHome(target: string) { return ALLOWED.includes(target) ? target : '/'; }",
].join('\n');

test('open-redirect: a project boolean check guards the redirect', () => {
  const guarded = 'const next = req.query.next as string; if (!isLocal(next)) return; res.redirect(next);';
  assert.equal(findings(redirectRoute(relativeCheck, guarded), 'open-redirect').length, 0);
  const unguarded = 'const next = req.query.next as string; isLocal(next); res.redirect(next);';
  assert.equal(findings(redirectRoute(relativeCheck, unguarded), 'open-redirect').length, 1);
});

test('open-redirect: a project function that throws, and one that returns the sanitized value', () => {
  const asserted = 'const next = req.query.next as string; assertLocal(next); res.redirect(next);';
  assert.equal(findings(redirectRoute(relativeCheck, asserted), 'open-redirect').length, 0);
  const sanitized = 'res.redirect(localOrHome(req.query.next as string));';
  assert.equal(findings(redirectRoute(relativeCheck, sanitized), 'open-redirect').length, 0);
  const unrelated = 'res.redirect(String(req.query.next));';
  assert.equal(findings(redirectRoute(relativeCheck, unrelated), 'open-redirect').length, 1);
});

test('open-redirect: a service that validates before redirecting two calls away', () => {
  const service = [
    relativeCheck,
    'class Redirects { check(target: string) { assertLocal(target); } }',
    'const redirects = new Redirects();',
    'function destination(target: string) { redirects.check(target); return target; }',
  ].join('\n');
  const body = 'const next = req.query.next as string; redirects.check(next); res.redirect(next);';
  assert.equal(findings(redirectRoute(service, body), 'open-redirect').length, 0);
});

const pathCheck = [
  "const ROOT = '/srv/files';",
  'function isInside(candidate: string) {',
  '  const resolved = path.resolve(ROOT, candidate);',
  '  return resolved.startsWith(ROOT + path.sep);',
  '}',
  'function assertInside(candidate: string) {',
  '  const resolved = path.resolve(ROOT, candidate);',
  "  if (!resolved.startsWith(ROOT + path.sep)) throw new Error('outside');",
  '}',
  'function insideOrDefault(candidate: string) {',
  '  const resolved = path.resolve(ROOT, candidate);',
  "  return resolved.startsWith(ROOT + path.sep) ? resolved : 'index.html';",
  '}',
].join('\n');

test('path-traversal: boolean, throwing and sanitizing project helpers stop the report', () => {
  const read = "await readFile(path.join('/srv/files', name));";
  const named = 'const name = req.params.name as string;';
  assert.equal(
    findings(fileRoute(pathCheck, `${named} if (!isInside(name)) return; ${read}`), 'path-traversal').length,
    0,
  );
  assert.equal(findings(fileRoute(pathCheck, `${named} assertInside(name); ${read}`), 'path-traversal').length, 0);
  assert.equal(
    findings(fileRoute(pathCheck, `const name = insideOrDefault(req.params.name as string); ${read}`), 'path-traversal')
      .length,
    0,
  );
  assert.equal(findings(fileRoute(pathCheck, `${named} ${read}`), 'path-traversal').length, 1);
});

test('without types the project helpers are still followed or the finding is kept', () => {
  const body =
    'const name = req.params.name as string; assertInside(name); await readFile(path.join("/srv/files", name));';
  const result = lintWithoutTypes(fileRoute(pathCheck, body), stubs.express).filter(
    (finding) => finding.ruleId === 'path-traversal',
  );
  assert.ok(result.length <= 1);
});

test('path-traversal: a file name holding a forward slash is rejected before the path is built', () => {
  const rejecting =
    "const name = req.params.name as string; if (name.includes('/')) return; await readFile(path.join('/srv', name));";
  assert.equal(findings(fileRoute('', rejecting), 'path-traversal').length, 0);
  const accepting =
    "const name = req.params.name as string; if (!name.includes('/')) { await readFile(path.join('/srv', name)); }";
  assert.equal(findings(fileRoute('', accepting), 'path-traversal').length, 0);
  const other =
    "const name = req.params.name as string; if (name.includes('x')) return; await readFile(path.join('/srv', name));";
  assert.equal(findings(fileRoute('', other), 'path-traversal').length, 1);
});
