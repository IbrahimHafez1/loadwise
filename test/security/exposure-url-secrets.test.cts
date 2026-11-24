import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.cjs';

const ruleId = 'secret-in-url-query';
const header = [
  "import express from 'express';",
  'const app = express();',
  'declare const apiKey: string;',
  'declare const base: string;',
  'declare const axios: any;',
].join('\n');

test('credentials read from the query string in handlers are reported', () => {
  const source = [
    header,
    "app.get('/a', (req, res) => { res.send(req.query.password); });",
    "app.get('/b', (req, res) => { res.send(req.query.api_key); });",
    "app.get('/c', (req, res) => { res.send(req.query.token); });",
    "app.get('/d', (req, res) => { res.send(new URL(req.url).searchParams.get('access_token')); });",
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, source).length, 4);
});

test('Nest @Query credential parameters are reported', () => {
  const source = [
    "import { Controller, Get, Query } from '@nestjs/common';",
    '@Controller()',
    'class Accounts {',
    "  @Get('login') login(@Query('password') password: string, @Query('page') page: string) { return password; }",
    '}',
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, source).length, 1);
});

test('link tokens are contextual, other query reads are quiet', () => {
  const source = [
    header,
    "app.get('/verify-email', (req, res) => { res.send(req.query.token); });",
    "app.get('/e', (req, res) => { res.send(req.query.page); res.send(req.query.key); });",
    'const outside = (request: any) => request.query.password;',
  ].join('\n');
  const findings = findingsOf(ruleId, source);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].contextualReason);
});

test('outgoing URLs and axios params with credentials are reported', () => {
  const source = [
    header,
    'fetch(`${base}/items?api_key=${apiKey}`);',
    "axios.get(base + '?x=1&token=' + apiKey);",
    'axios.get(base, { params: { api_key: apiKey, page: 1 } });',
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, source).length, 3);
});

test('literal values, other parameters and third-party key APIs are handled', () => {
  const source = [
    header,
    'fetch(`${base}?token=abc`);',
    'fetch(`${base}?page=${apiKey}`);',
    'fetch(`https://maps.googleapis.com/maps/api/geocode/json?api_key=${apiKey}`);',
  ].join('\n');
  const findings = findingsOf(ruleId, source);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].contextualReason);
});
