'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintBothWays, lintWithoutTypes, stubs } = require('./helpers.cjs');

const ruleId = 'ssrf-request-url';

function expressRoute(body, preamble = '') {
  return [
    "import express from 'express';",
    "import axios from 'axios';",
    preamble,
    'const app = express();',
    `app.get('/proxy', async (req, res) => { ${body} });`,
  ].join('\n');
}

function findings(source, files = stubs.express) {
  return lintBothWays(source, files).typed.filter((finding) => finding.ruleId === ruleId);
}

test('a request URL from the request is reported for fetch, axios and http clients', () => {
  const [direct] = findings(expressRoute('await fetch(req.query.url as string);'));
  assert.match(direct.message, /comes from `req\.query\.url`/);
  assert.equal(direct.contextualReason, undefined);
  assert.equal(findings(expressRoute('const target = req.body.target; await axios.get(target);')).length, 1);
  assert.equal(findings(expressRoute('await axios({ url: req.body.url, method: "get" });')).length, 1);
  assert.equal(
    findings(expressRoute('await api.post(req.body.url, {});', 'const api = axios.create({ timeout: 1000 });')).length,
    1,
  );
  assert.equal(
    findings(expressRoute("https.get({ hostname: req.query.host, path: '/' });", "import https from 'https';")).length,
    1,
  );
});

test('a host chosen inside a URL template is reported, a path after a fixed origin is not', () => {
  assert.equal(findings(expressRoute('await fetch(`https://${req.query.host}/status`);')).length, 1);
  assert.equal(findings(expressRoute('await fetch(`${req.protocol}://${req.query.host}/status`);')).length, 1);
  assert.equal(findings(expressRoute('await fetch(`https://api.example.com/items/${req.params.id}`);')).length, 0);
  assert.equal(
    findings(expressRoute('await axios.get(`${API}/users/${req.params.id}`);', 'const API = process.env.API_URL;'))
      .length,
    0,
  );
  assert.equal(
    findings(
      expressRoute(
        'const url = `${this_base()}/users/${req.params.id}`; await fetch(url);',
        'declare function this_base(): string;',
      ),
    ).length,
    0,
  );
  assert.equal(findings(expressRoute('await fetch(new URL(`/items/${req.params.id}`, process.env.API));')).length, 0);
  assert.equal(findings(expressRoute('await fetch(new URL(req.query.next as string, process.env.API));')).length, 1);
});

test('host allowlists, validators and SSRF-filtering agents keep the request quiet', () => {
  const allowlisted = [
    'const target = new URL(req.query.url as string);',
    "if (!ALLOWED.has(target.hostname)) return res.status(400).send('no');",
    'await fetch(target);',
  ].join(' ');
  assert.equal(findings(expressRoute(allowlisted, "const ALLOWED = new Set(['api.example.com']);")).length, 0);
  const validated = 'const url = req.body.url; await assertPublicUrl(url); await axios.get(url);';
  assert.equal(
    findings(expressRoute(validated, 'declare function assertPublicUrl(u: string): Promise<void>;')).length,
    0,
  );
  const filtered = 'await axios.get(req.body.url, { httpAgent: ssrfFilter(req.body.url) });';
  assert.equal(findings(expressRoute(filtered, "import ssrfFilter from 'ssrf-req-filter';")).length, 0);
});

test('server values, non-request calls and local fetch functions are not reported', () => {
  assert.equal(findings(expressRoute('await fetch(process.env.WEBHOOK_URL as string);')).length, 0);
  assert.equal(findings(expressRoute('await axios.get(req.user.avatarUrl);')).length, 0);
  assert.equal(findings(expressRoute('axios.isAxiosError(req.body.url);')).length, 0);
  assert.equal(
    findings(expressRoute('await fetch(req.query.url as string);', 'function fetch(key: string) { return key; }'))
      .length,
    0,
  );
});

test('the Host header is contextual and a second call hop is contextual', () => {
  const [host] = findings(expressRoute("await fetch(`http://${req.get('host')}/internal`);"));
  assert.match(host.contextualReason, /Host header/);
  const twoHops = expressRoute(
    'outer(req.query.url as string);',
    'async function inner(url: string) { await fetch(url); }\nasync function outer(url: string) { await inner(url); }',
  );
  const [hop] = findings(twoHops);
  assert.match(hop.contextualReason, /two calls/);
});

test('NestJS HttpService requests with a query URL are reported without installed types', () => {
  const source = [
    "import { Controller, Get, Query } from '@nestjs/common';",
    "import { HttpService } from '@nestjs/axios';",
    '@Controller() class Preview {',
    '  constructor(private readonly http: HttpService) {}',
    "  @Get() load(@Query('url') url: string) { return this.http.get(url); }",
    "  @Get() fixed(@Query('id') id: string) { return this.http.get(`https://api.example.com/${id}`); }",
    '}',
  ].join('\n');
  const result = lintWithoutTypes(source, stubs.nest).filter((finding) => finding.ruleId === ruleId);
  assert.deepEqual(
    result.map((finding) => finding.line),
    [5],
  );
});
