// The taint engine through its public interface: sources, propagation, sanitizers and the bounded
// call hops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withContext, sinkArgument, stubs } from './helpers.js';
import type { SourceFile } from 'typescript';
import type { SecurityRuleContext, SinkKind } from '../../lib/shared/types.js';

const sinkDeclaration = 'declare function sink(value: unknown): void;';

function traced(source: string, files: Record<string, string> = stubs.express, sinkKind: SinkKind = 'sql') {
  return withContext(source, files, (context: SecurityRuleContext, sourceFile: SourceFile) =>
    context.taint.trace(sinkArgument(sourceFile), sinkKind),
  );
}

// `trace` takes a SinkKind; Reflect.apply lets a test hand it a kind outside that union.
function tracedWithKind(source: string, sinkKind: string) {
  return withContext(source, stubs.express, (context: SecurityRuleContext, sourceFile: SourceFile) =>
    Reflect.apply(context.taint.trace, context.taint, [sinkArgument(sourceFile), sinkKind]),
  );
}

function expressRoute(body: string, preamble = '') {
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
  assert.ok(typed);
  assert.equal(typed.label, 'req.query.sort');
  assert.equal(typed.sourceKind, 'request');
  assert.equal(typed.hops, 0);
  assert.equal(typed.whole, false);
  assert.ok(typed.steps.length >= 2);
  assert.deepEqual(Object.keys(typed.steps[0]), ['file', 'line', 'text']);
  assert.equal(traced(expressRoute('sink(req.body.name.trim());'), {})?.label, 'req.body.name');
});

test('server-derived request fields and handlers that are not routes are clean', () => {
  assert.equal(traced(expressRoute('sink(req.user.id);')), undefined);
  const helper = `${sinkDeclaration}\nfunction format(req: { query: { q: string } }, width: number) { sink(req.query.q); }`;
  assert.equal(traced(helper, {}), undefined);
});

test('archive names are distinct sources through destructuring and a local call', () => {
  const source = [
    "import Archive from 'adm-zip';",
    "import { join as combine } from 'node:path';",
    sinkDeclaration,
    'declare const archive: string, directory: string;',
    'function record(name: string) { sink(combine(directory, name)); }',
    'const entries = new Archive(archive).getEntries();',
    'for (const { entryName: label } of entries) record(label);',
  ].join('\n');
  const result = traced(source, {}, 'archive-path');
  assert.equal(result?.sourceKind, 'archive-entry');
  assert.equal(result?.hops, 1);
  assert.match(result.label, /entryName|label/);
  assert.equal(Boolean(traced(source, {}, 'path')), false);
});

test('nest parameter decorators are sources and a parsing pipe sanitizes', () => {
  const controller = (parameter: string) =>
    [
      "import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';",
      sinkDeclaration,
      `@Controller() class Items { @Get() find(${parameter}) { sink(\`id \${value}\`); } }`,
    ].join('\n');
  assert.equal(traced(controller("@Query('q') value: string"), stubs.nest)?.label, "@Query('q') value");
  assert.equal(traced(controller("@Param('id', ParseIntPipe) value: number"), stubs.nest), undefined);
});

test('values pass through local wrappers and string methods but not through unknown calls', () => {
  assert.equal(
    traced(expressRoute('sink(wrap(req.query.q));', "const wrap = (value: string) => 'x' + value;"))?.label,
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

test('string method aliases sanitize NoSQL values while object methods of the same name do not', () => {
  const stringMethod = expressRoute('const value = req.body.name.trim(); sink(value);');
  assert.equal(Boolean(traced(stringMethod, stubs.express, 'nosql')), false);
  assert.equal(traced(stringMethod)?.label, 'req.body.name');
  const objectMethod = expressRoute('sink((req.body as { slice(): object }).slice());');
  assert.ok(traced(objectMethod, stubs.express, 'nosql'));
});

test('regex escaping sanitizes only the escaped part and only for regex sinks', () => {
  const metacharacters = /[.*+?^${}()|[\]\\]/g;
  const preamble = `const escapePattern = (text: string) => text.replace(${metacharacters}, '\\\\$&');`;
  const source = expressRoute('const escaped = escapePattern(req.query.term); sink(escaped);', preamble);
  assert.equal(Boolean(traced(source, stubs.express, 'regex')), false);
  assert.equal(traced(source)?.label, 'req.query.term');
  const mixed = expressRoute('sink(escapePattern(req.query.term) + req.query.suffix);', preamble);
  assert.equal(traced(mixed, stubs.express, 'regex')?.label, 'req.query.suffix');
  const partial = expressRoute("sink(req.query.term.replace(/[a-z]/g, '\\\\$&'));");
  assert.equal(traced(partial, stubs.express, 'regex')?.label, 'req.query.term');
});

test('a spread request body is whole and an unknown sink kind is rejected', () => {
  assert.equal(traced(expressRoute('sink({ ...req.body });'), stubs.express, 'mass-assignment')?.whole, true);
  const unknownKind = 'xpath';
  assert.throws(() => tracedWithKind(expressRoute('sink(req.body);'), unknownKind), /Unknown sink kind: xpath/);
});

test('callers are followed for three hops and a fourth hop stays silent', () => {
  const chain = (functions: string[], entry: string) =>
    expressRoute(`${entry}(req.query.q);`, ['function inner(text: string) { sink(text); }', ...functions].join('\n'));
  assert.equal(traced(chain([], 'inner'))?.hops, 1);
  assert.equal(traced(chain(['function outer(value: string) { inner(value); }'], 'outer'))?.hops, 2);
  const threeHops = chain(
    ['function middle(value: string) { inner(value); }', 'function outer(value: string) { middle(value); }'],
    'outer',
  );
  assert.equal(traced(threeHops)?.hops, 3);
  const fourHops = chain(
    [
      'function mid1(value: string) { inner(value); }',
      'function mid2(value: string) { mid1(value); }',
      'function outer(value: string) { mid2(value); }',
    ],
    'outer',
  );
  assert.equal(traced(fourHops), undefined);
});

test('the trace keeps a request field read after crossing a call boundary', () => {
  const source = expressRoute('format(req.body);', 'function format(payload: any) { sink(payload.profile.name); }');
  const result = traced(source);
  assert.ok(result);
  assert.equal(result.label, 'req.body.profile.name');
  assert.equal(result.hops, 1);
  assert.equal(result.steps.at(-1)?.text, 'payload.profile.name');
});

test('a field destructured after a call hop keeps its request path in the label', () => {
  const destructuredParameter = traced(
    expressRoute('save(req.body);', 'function save({ name }: { name: string }) { sink(`name ${name}`); }'),
  );
  assert.ok(destructuredParameter);
  assert.equal(destructuredParameter.label, 'req.body.name');
  assert.equal(destructuredParameter.hops, 1);
  const destructuredInside = traced(
    expressRoute('save(req.body);', 'function save(payload: any) { const { name } = payload; sink(name); }'),
  );
  assert.ok(destructuredInside);
  assert.equal(destructuredInside.label, 'req.body.name');
  assert.equal(
    traced(expressRoute('save(req.query.q);', 'function save(text: string) { sink(text); }'))?.label,
    'req.query.q',
  );
});

test('a Nest controller value passed to a constructor-injected service reaches the service sink', () => {
  const source = [
    "import { Body, Controller, Post } from '@nestjs/common';",
    sinkDeclaration,
    'class ItemsService { find(term: string) { sink(`SELECT * FROM items WHERE name = ${term}`); } }',
    '@Controller() class ItemsController {',
    '  constructor(private readonly items: ItemsService) {}',
    '  @Post() create(@Body() dto: { name: string }) { return this.items.find(dto.name); }',
    '}',
  ].join('\n');
  for (const files of [stubs.nest, {}]) {
    const result = traced(source, files);
    assert.ok(result);
    assert.equal(result.label, '@Body() dto.name');
    assert.equal(result.hops, 1);
    assert.deepEqual(
      result.steps.map((entry) => entry.text),
      ['@Body() dto: { name: string }', 'this.items.find(dto.name)', 'term: string'],
    );
  }
});

const fastifyStub = {
  'node_modules/fastify/index.d.ts': [
    'export interface FastifyRequest { body: unknown; query: unknown; ip: string; ips?: string[]; protocol: string;',
    '  routerPath: string; raw: { url?: string; headers: Record<string, string> } }',
    'declare function fastify(): { get(path: string, handler: (request: any, reply: any) => unknown): void };',
    'export default fastify;',
  ].join('\n'),
};

test('fastify requests expose proxy-derived fields and the raw Node request, not the route pattern', () => {
  const typed = (expression: string) =>
    traced(
      [
        "import { FastifyRequest } from 'fastify';",
        sinkDeclaration,
        `export function handle(request: FastifyRequest) { sink(${expression}); }`,
      ].join('\n'),
      fastifyStub,
    );
  assert.equal(typed('request.raw.url')?.label, 'request.raw.url');
  assert.equal(typed('request.raw.headers')?.whole, true);
  assert.equal(typed('request.ip')?.label, 'request.ip');
  assert.equal(typed('request.ips')?.whole, true);
  assert.equal(typed('request.protocol')?.label, 'request.protocol');
  assert.equal(typed('request.routerPath'), undefined);
  const route = [
    "import fastify from 'fastify';",
    sinkDeclaration,
    'const app = fastify();',
    "app.get('/items', async (request, reply) => { sink(request.raw.url); });",
  ].join('\n');
  for (const files of [fastifyStub, {}]) assert.equal(traced(route, files)?.label, 'request.raw.url');
});

test('urlControl tells a controlled path from a controlled host', () => {
  const control = (body: string) =>
    withContext(expressRoute(body), stubs.express, (context: SecurityRuleContext, sourceFile: SourceFile) =>
      context.taint.urlControl(sinkArgument(sourceFile)),
    );
  assert.equal(control("sink('https://api.example.com/items/' + req.query.id);")?.part, 'path');
  assert.equal(control('sink(req.query.target);')?.part, 'whole');
  assert.equal(control("sink('https://api.example.com/items');"), undefined);
  assert.equal(control('const destination = `https://${req.query.host}/items`; sink(destination);')?.part, 'host');
  assert.equal(control("const target = new URL('/items', req.query.base); sink(target);")?.part, 'whole');
  assert.equal(control('const target = new URL(req.query.url); sink(target.pathname);')?.part, 'path');
  assert.equal(control('sink(req.query.pathname);')?.part, 'whole');
  assert.equal(control('sink(`/${req.query.target}`);')?.part, 'whole');
});

test('a local const formatter keeps its explicit path prefix in a composed URL', () => {
  const source = expressRoute(
    'const base = formatPath(req.params.team); sink(`${base}/edit`);',
    'const formatPath = (team: string) => { return `/teams/${team}/documents`; };',
  );
  const part = withContext(
    source,
    stubs.express,
    (context: SecurityRuleContext, file) => context.taint.urlControl(sinkArgument(file))?.part,
  );
  assert.equal(part, 'path');
});

test('a formatter with server data still anchors request data appended by its caller', () => {
  const source = expressRoute(
    'const base = formatPath("assigned-team"); sink(`${base}/${req.params.id}`);',
    'const formatPath = (team: string) => `/teams/${team}/documents`;',
  );
  const part = withContext(
    source,
    stubs.express,
    (context: SecurityRuleContext, file) => context.taint.urlControl(sinkArgument(file))?.part,
  );
  assert.equal(part, 'path');
});

test('isUntracedParameter is true only for a parameter with no known source', () => {
  const untraced = (source: string, files: Record<string, string>) =>
    withContext(source, files, (context: SecurityRuleContext, sourceFile: SourceFile) =>
      context.taint.isUntracedParameter(sinkArgument(sourceFile)),
    );
  assert.equal(untraced(`${sinkDeclaration}\nexport function run(text: string) { sink(text); }`, {}), true);
  assert.equal(untraced(expressRoute('sink(req);'), stubs.express), false);
  assert.equal(untraced(`${sinkDeclaration}\nsink('fixed');`, {}), false);
});
