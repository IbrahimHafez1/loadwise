'use strict';

// Library recognition tiers: import (project syntax only), type (installed declarations) and unique method name.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { withContext, stubs } = require('./helpers.cjs');

// The libraryCall result of each call in the file, in source order (null when the call is not recognised), without
// the fields a tier leaves undefined.
function recognised(source, files = {}) {
  const results = withContext(source, files, (context, sourceFile) => {
    const found = [];
    (function visit(node) {
      if (ts.isCallExpression(node)) found.push(context.libraryCall(node) ?? null);
      ts.forEachChild(node, visit);
    })(sourceFile);
    return found;
  });
  return JSON.parse(JSON.stringify(results));
}

test('imports and requires bind without any installed package', () => {
  const exec = { module: 'child_process', exported: 'exec', tier: 'import' };
  assert.deepEqual(recognised("import { exec } from 'node:child_process';\nexec('ls');"), [exec]);
  assert.deepEqual(recognised("import * as cp from 'child_process';\ncp.exec('ls');"), [exec]);
  assert.deepEqual(recognised("const { exec: run } = require('child_process');\nrun('ls');"), [null, exec]);
  assert.deepEqual(recognised("import { exec } from 'node:child_process';\nexec('ls');", stubs.childProcess), [exec]);
});

test('an annotated parameter property binds through its imported type name', () => {
  const source = [
    "import { DataSource } from 'typeorm';",
    "export class Reports { constructor(private readonly db: DataSource) {} run() { return this.db.query('x'); } }",
  ].join('\n');
  assert.deepEqual(recognised(source), [
    { module: 'typeorm', exported: 'DataSource', method: 'query', tier: 'import' },
  ]);
});

test('a factory-returned instance needs the installed types', () => {
  const source = [
    "import { DataSource } from 'typeorm';",
    'declare function connect(): DataSource;',
    'const db = connect();',
    "db.query('x');",
  ].join('\n');
  assert.deepEqual(recognised(source, stubs.typeorm)[1], {
    module: 'typeorm',
    exported: 'DataSource',
    method: 'query',
    tier: 'type',
  });
  assert.equal(recognised(source)[1], null);
});

test('unique method names are recognised by name and local functions are not library calls', () => {
  assert.deepEqual(recognised("declare const prisma: any;\nprisma.$queryRawUnsafe('x');"), [
    { method: '$queryRawUnsafe', tier: 'name' },
  ]);
  assert.deepEqual(recognised("function exec(command: string) {}\nexec('ls');"), [null]);
});
