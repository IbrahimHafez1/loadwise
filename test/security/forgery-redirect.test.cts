import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintBothWays, lintWithoutTypes, stubs } from './helpers.cjs';
import type { LocatedFinding } from '../types/security.cjs';

const ruleId = 'open-redirect';

function expressRoute(body: string, preamble = '') {
  return [
    "import express from 'express';",
    preamble,
    'const app = express();',
    `app.get('/login', (req, res) => { ${body} });`,
  ].join('\n');
}

function findings(source: string, files = stubs.express) {
  return lintBothWays(source, files).typed.filter((finding: LocatedFinding) => finding.ruleId === ruleId);
}

test('a redirect to a request-supplied URL is reported in each response form', () => {
  const [direct] = findings(expressRoute('res.redirect(req.query.next as string);'));
  assert.match(direct.message, /comes from `req\.query\.next`/);
  assert.equal(direct.contextualReason, undefined);
  assert.equal(findings(expressRoute('const next = req.query.returnTo; res.redirect(302, next);')).length, 1);
  assert.equal(findings(expressRoute('res.status(302).redirect(req.body.next);')).length, 1);
  assert.equal(findings(expressRoute("res.setHeader('Location', req.query.to as string); res.end();")).length, 1);
  assert.equal(findings(expressRoute('res.writeHead(302, { Location: req.query.to });')).length, 1);
  assert.equal(findings(expressRoute('res.writeHead(302, "Found", { lOcAtIoN: req.query.to });')).length, 1);
  assert.equal(findings(expressRoute('res.redirect(`https://${req.query.domain}/home`);')).length, 1);
});

test('relative paths, fixed origins and checked targets are not reported', () => {
  assert.equal(findings(expressRoute("res.redirect('/items/' + req.params.id);")).length, 0);
  assert.equal(findings(expressRoute('res.redirect(`https://app.example.com/${req.query.page}`);')).length, 0);
  const relativeGuard = [
    'const next = req.query.next as string;',
    String.raw`if (!next.startsWith('/') || next.startsWith('//') || /[\\\t\r\n]/.test(next)) return res.redirect('/');`,
    'res.redirect(next);',
  ].join(' ');
  assert.equal(findings(expressRoute(relativeGuard)).length, 0);
  const allowlist = 'const next = req.query.next as string; if (!ALLOWED.includes(next)) return; res.redirect(next);';
  assert.equal(findings(expressRoute(allowlist, "const ALLOWED = ['https://a.example.com'];")).length, 0);
  assert.equal(findings(expressRoute("res.redirect(process.env.APP_URL ?? '/');")).length, 0);
  assert.equal(findings(expressRoute("res.redirect('https://' + req.headers.host + req.url);")).length, 0);
  assert.equal(findings(expressRoute('store.redirect(req.query.next);', 'declare const store: any;')).length, 0);
});

test('a relative-path check must reject incomplete validation before redirecting', () => {
  const setup = 'const next = req.query.next as string;';
  const send = 'res.redirect(next);';
  const remainder = String.raw`next.startsWith('//') || /[\\\t\r\n]/.test(next)`;
  for (const body of [
    `${setup} if (!next.startsWith('/')) return; ${send}`,
    `${setup} if (!next.startsWith('/') || next.startsWith('//')) return; ${send}`,
    `${setup} ${send} if (!next.startsWith('/') || ${remainder}) return;`,
    `${setup} if (!next.startsWith('/') || ${remainder}) console.warn(next); ${send}`,
  ]) {
    assert.equal(findings(expressRoute(body)).length, 1, body);
  }
});

test('a Referer target and a second call hop are contextual', () => {
  const [referer] = findings(expressRoute("res.redirect(req.get('referer') ?? '/');"));
  assert.match(referer.contextualReason ?? '', /Referer/);
  const twoHops = expressRoute(
    'outer(res, req.query.next as string);',
    'function inner(res: any, to: string) { res.redirect(to); }\nfunction outer(res: any, to: string) { inner(res, to); }',
  );
  assert.match(findings(twoHops)[0].contextualReason ?? '', /two calls/);
});

test('Remix, Next.js and NestJS redirects are recognised without installed types', () => {
  const remix = [
    "import { redirect } from '@remix-run/node';",
    'export async function loader({ request }: { request: Request }) {',
    "  const to = new URL(request.url).searchParams.get('redirectTo');",
    "  if (!to) throw redirect('/pages' + new URL(request.url).pathname.replace('/old', '/new'));",
    "  return redirect(to ?? '/');",
    '}',
  ].join('\n');
  assert.deepEqual(
    lintWithoutTypes(remix)
      .filter((finding: LocatedFinding) => finding.ruleId === ruleId)
      .map((finding: LocatedFinding) => finding.line),
    [5],
  );
  const nest = [
    "import { Controller, Get, Query, Redirect } from '@nestjs/common';",
    '@Controller() class Links {',
    "  @Get() @Redirect() go(@Query('to') to: string) { return { url: to }; }",
    "  @Get() @Redirect() home(@Query('page') page: string) { return { url: `/home/${page}` }; }",
    "  @Get() plain(@Query('to') to: string) { return { url: to }; }",
    '}',
  ].join('\n');
  assert.deepEqual(
    lintWithoutTypes(nest, stubs.nest)
      .filter((finding: LocatedFinding) => finding.ruleId === ruleId)
      .map((finding: LocatedFinding) => finding.line),
    [3],
  );
});
