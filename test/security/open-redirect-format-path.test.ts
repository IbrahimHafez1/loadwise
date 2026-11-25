import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintBothWays, stubs } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const ruleId = 'open-redirect';

function routeWithHelper(helper: string) {
  return [
    "import express from 'express';",
    helper,
    'const app = express();',
    "app.get('/login', (req, res) => { res.redirect(formatPath(req.query.next as string)); });",
  ].join('\n');
}

function findings(source: string) {
  return lintBothWays(source, stubs.express).typed.filter((finding: Finding) => finding.ruleId === ruleId);
}

test('a helper that prefixes a fixed path is not an open redirect', () => {
  const stripped = String.raw`function formatPath(path: string) { return '/' + path.replace(/^[\/\\]+/, ''); }`;
  const template = 'function formatPath(path: string) { return `/app/${path}`; }';
  const concatenated = "const formatPath = (path: string) => '/app/' + path;";
  assert.equal(findings(routeWithHelper(stripped)).length, 0);
  assert.equal(findings(routeWithHelper(template)).length, 0);
  assert.equal(findings(routeWithHelper(concatenated)).length, 0);
});

test('a helper that can return a protocol-relative or unprefixed target is still reported', () => {
  const bareSlash = "function formatPath(path: string) { return '/' + path; }";
  // `/\evil.com` survives a forward-slash strip, and browsers read it as `//evil.com`.
  const forwardOnly = String.raw`function formatPath(path: string) { return '/' + path.replace(/^\/+/, ''); }`;
  const passThrough = 'function formatPath(path: string) { return path; }';
  const oneBranchSafe = "function formatPath(path: string) { if (path) return '/app/' + path; return path; }";
  assert.equal(findings(routeWithHelper(bareSlash)).length, 1);
  assert.equal(findings(routeWithHelper(forwardOnly)).length, 1);
  assert.equal(findings(routeWithHelper(passThrough)).length, 1);
  assert.equal(findings(routeWithHelper(oneBranchSafe)).length, 1);
});
