'use strict';

// Fastify and NestJS request sources: each request field or decorated parameter is client data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withContext, sinkArgument, stubs } = require('./helpers.cjs');

const sinkDeclaration = 'declare function sink(value: unknown): void;';
const fastifyStub = {
  'node_modules/fastify/index.d.ts': [
    'export interface FastifyRequest<T = unknown> { body: unknown; query: unknown; params: unknown;',
    '  headers: Record<string, string>; user?: { id: string } }',
    'interface Instance { get(path: string, handler: (request: any, reply: any) => unknown): void;',
    '  post(path: string, handler: (request: any, reply: any) => unknown): void;',
    '  route(options: { method: string; url: string; handler: (request: any, reply: any) => unknown }): void }',
    'declare function fastify(): Instance;',
    'export default fastify;',
  ].join('\n'),
};
const requestFields = ['body', 'query', 'params', 'headers'];

function traced(source, files) {
  return withContext(source, files, (context, sourceFile) => context.taint.trace(sinkArgument(sourceFile), 'sql'));
}

test('fields of a FastifyRequest-typed parameter are request data', () => {
  for (const field of requestFields) {
    const source = [
      "import type { FastifyRequest } from 'fastify';",
      sinkDeclaration,
      `export function handle(request: FastifyRequest<{ Body: object }>) { sink(request.${field}); }`,
    ].join('\n');
    const result = traced(source, fastifyStub);
    assert.equal(result?.label, `request.${field}`, field);
    assert.equal(result.sourceKind, 'request');
  }
  const serverField = [
    "import { FastifyRequest } from 'fastify';",
    sinkDeclaration,
    'export function handle(request: FastifyRequest) { sink(request.user?.id); }',
  ].join('\n');
  assert.equal(traced(serverField, fastifyStub), undefined);
});

test('fields of fastify get, post and route handlers are request data with and without types', () => {
  const registrations = [
    (field) => `app.get('/items', async (request, reply) => { sink(request.${field}); });`,
    (field) => `app.post('/items', async (request, reply) => { sink(request.${field}); });`,
    (field) =>
      `app.route({ method: 'POST', url: '/items', handler: async (request, reply) => { sink(request.${field}); } });`,
  ];
  for (const register of registrations)
    for (const field of requestFields) {
      const source = [
        "import fastify from 'fastify';",
        sinkDeclaration,
        'const app = fastify();',
        register(field),
      ].join('\n');
      for (const files of [fastifyStub, {}]) assert.equal(traced(source, files)?.label, `request.${field}`, source);
    }
});

test('a callback registered on a receiver that is not fastify is not request data', () => {
  const source = [
    sinkDeclaration,
    'declare const cache: { get(key: string, callback: (entry: any) => void): void };',
    "cache.get('/items', (entry) => { sink(entry.body); });",
  ].join('\n');
  assert.equal(traced(source, {}), undefined);
});

test('Nest @Body, @Query, @Param and @Headers parameters are request data', () => {
  const controller = (parameter) =>
    [
      "import { Body, Controller, Get, Headers, Param, Query } from '@nestjs/common';",
      sinkDeclaration,
      `@Controller() class Items { @Get() find(${parameter}) { sink(value); } }`,
    ].join('\n');
  const cases = [
    ['@Body() value: object', '@Body() value', true],
    ["@Body('name') value: string", "@Body('name') value", false],
    ['@Query() value: object', '@Query() value', true],
    ["@Query('q') value: string", "@Query('q') value", false],
    ['@Param() value: object', '@Param() value', true],
    ["@Param('id') value: string", "@Param('id') value", false],
    ['@Headers() value: object', '@Headers() value', true],
    ["@Headers('x-tenant') value: string", "@Headers('x-tenant') value", false],
  ];
  for (const [parameter, label, whole] of cases) {
    const result = traced(controller(parameter), stubs.nest);
    assert.equal(result?.label, label, parameter);
    assert.equal(result.whole, whole, parameter);
    assert.equal(result.sourceKind, 'request');
  }
  assert.equal(traced(controller('value: string'), stubs.nest), undefined);
});
