'use strict';

// The taint engine through its public interface: sources, propagation, sanitizers and the bounded call hops.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withContext, sinkArgument, stubs } = require('./helpers.cjs');

const sinkDeclaration = 'declare function sink(value: unknown): void;';

function traced(source, files = stubs.express, sinkKind = 'sql') {
  return withContext(source, files, (context, sourceFile) => context.taint.trace(sinkArgument(sourceFile), sinkKind));
}

function expressRoute(body, preamble = '') {
  return [
    "import express from 'express';",
    sinkDeclaration,
    preamble,
    'const app = express();',
    `app.get('/items', (req, res) => { ${body} });`,
  ].join('\n');
}

test('express request fields are sources with and without the installed types', () => {
  const source = expressRoute('const sort = req.query.sort; sink("ORDER BY " + sort);');
  const typed = traced(source);
  assert.equal(typed.label, 'req.query.sort');
  assert.equal(typed.sourceKind, 'request');
  assert.equal(typed.hops, 0);
  assert.equal(typed.whole, false);
  assert.ok(typed.steps.length >= 2);
  assert.deepEqual(Object.keys(typed.steps[0]), ['file', 'line', 'text']);
  assert.equal(traced(expressRoute('sink(req.body.name.trim());'), {}).label, 'req.body.name');
});

test('server-derived request fields and handlers that are not routes are clean', () => {
  assert.equal(traced(expressRoute('sink(req.user.id);')), undefined);
  const helper = `${sinkDeclaration}\nfunction format(req: { query: { q: string } }, width: number) { sink(req.query.q); }`;
  assert.equal(traced(helper, {}), undefined);
});

test('nest parameter decorators are sources and a parsing pipe sanitizes', () => {
  const controller = (parameter) =>
    [
      "import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';",
      sinkDeclaration,
      `@Controller() class Items { @Get() find(${parameter}) { sink(\`id \${value}\`); } }`,
    ].join('\n');
  assert.equal(traced(controller("@Query('q') value: string"), stubs.nest).label, "@Query('q') value");
  assert.equal(traced(controller("@Param('id', ParseIntPipe) value: number"), stubs.nest), undefined);
});

test('values pass through local wrappers and string methods but not through unknown calls', () => {
  assert.equal(
    traced(expressRoute('sink(wrap(req.query.q));', "const wrap = (value: string) => 'x' + value;")).label,
    'req.query.q',
  );
  assert.equal(
    traced(expressRoute('sink(escape(req.query.q));', 'declare function escape(v: string): string;')),
    undefined,
  );
});

test('numeric conversions, allowlist guards and String() for NoSQL sanitize', () => {
  assert.equal(traced(expressRoute('sink(Number(req.query.n));')), undefined);
  const guarded = 'const s = req.query.s; if (!ALLOWED.includes(s)) return; sink(s);';
  assert.equal(traced(expressRoute(guarded, "const ALLOWED = ['name', 'date'];")), undefined);
  assert.equal(traced(expressRoute('sink(String(req.body.n));'), stubs.express, 'nosql'), undefined);
  assert.ok(traced(expressRoute('sink(req.body.n);'), stubs.express, 'nosql'));
});

test('a spread request body is whole and an unknown sink kind is rejected', () => {
  assert.equal(traced(expressRoute('sink({ ...req.body });'), stubs.express, 'mass-assignment').whole, true);
  assert.throws(() => traced(expressRoute('sink(req.body);'), stubs.express, 'xpath'), /Unknown sink kind: xpath/);
});

test('callers are followed for two hops and a third hop stays silent', () => {
  const chain = (functions, entry) =>
    expressRoute(`${entry}(req.query.q);`, ['function inner(text: string) { sink(text); }', ...functions].join('\n'));
  assert.equal(traced(chain([], 'inner')).hops, 1);
  assert.equal(traced(chain(['function outer(value: string) { inner(value); }'], 'outer')).hops, 2);
  const threeHops = chain(
    ['function middle(value: string) { inner(value); }', 'function outer(value: string) { middle(value); }'],
    'outer',
  );
  assert.equal(traced(threeHops), undefined);
});

test('urlControl tells a controlled path from a controlled host', () => {
  const control = (body) =>
    withContext(expressRoute(body), stubs.express, (context, sourceFile) =>
      context.taint.urlControl(sinkArgument(sourceFile)),
    );
  assert.equal(control("sink('https://api.example.com/items/' + req.query.id);").part, 'path');
  assert.equal(control('sink(req.query.target);').part, 'whole');
  assert.equal(control("sink('https://api.example.com/items');"), undefined);
});

test('isUntracedParameter is true only for a parameter with no known source', () => {
  const untraced = (source, files) =>
    withContext(source, files, (context, sourceFile) => context.taint.isUntracedParameter(sinkArgument(sourceFile)));
  assert.equal(untraced(`${sinkDeclaration}\nexport function run(text: string) { sink(text); }`, {}), true);
  assert.equal(untraced(expressRoute('sink(req);'), stubs.express), false);
  assert.equal(untraced(`${sinkDeclaration}\nsink('fixed');`, {}), false);
});
