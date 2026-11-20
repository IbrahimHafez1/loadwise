'use strict';

// Fewer types never mean more findings: a project without node_modules gets the same or fewer findings and traces.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { lintBothWays, withContext, localFiles, stubs } = require('./helpers.cjs');

const pgTypes = {
  'node_modules/@types/pg/index.d.ts':
    'export class Pool { query(text: string | { text: string }, values?: unknown[]): Promise<unknown> }',
};

test('the moved rules report the same or fewer findings without installed types', () => {
  const source = [
    "import express from 'express';",
    "import type { Pool } from 'pg';",
    'declare const pool: Pool;',
    'const app = express();',
    "app.get('/items', (req, res) => pool.query('SELECT * FROM items ORDER BY ' + req.query.sort));",
    "export const fixed = (table: string) => pool.query('SELECT * FROM ' + table);",
  ].join('\n');
  const { typed, untyped } = lintBothWays(source, { ...stubs.express, ...pgTypes });
  assert.deepEqual(
    typed.map(({ line, ruleId }) => [line, ruleId]),
    [
      [5, 'pg-dynamic-query-text'],
      [6, 'pg-dynamic-query-text'],
    ],
  );
  assert.deepEqual(untyped, []);
});

test('every expression traced without types is also traced with them', () => {
  const source = [
    "import express from 'express';",
    "import { Controller, Get, Query } from '@nestjs/common';",
    'declare function use(...values: unknown[]): void;',
    'const app = express();',
    "app.post('/items', (req, res) => use(req.body.name, req.query.q.trim(), req.user, Number(req.query.n)));",
    "@Controller() class Items { @Get() find(@Query('q') q: string, plain: string) { use(`x${q}`, plain); } }",
  ].join('\n');
  const files = { ...stubs.express, ...stubs.nest };
  const tracedArguments = (programFiles) =>
    withContext(source, programFiles, (context, sourceFile) => {
      const labels = [];
      (function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'use') {
          for (const argument of node.arguments) labels.push(context.taint.trace(argument, 'sql')?.label ?? null);
        }
        ts.forEachChild(node, visit);
      })(sourceFile);
      return labels;
    });
  const typed = tracedArguments(files);
  const untyped = tracedArguments(localFiles(files));
  assert.deepEqual(typed, ['req.body.name', 'req.query.q', null, null, "@Query('q') q", null]);
  untyped.forEach((label, index) => assert.ok(label === null || label === typed[index], `argument ${index}`));
});
