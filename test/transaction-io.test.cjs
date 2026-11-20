'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lint } = require('./helpers.cjs');

const files = {
  'globals.d.ts': 'declare function fetch(url: string): Promise<{ ok: boolean }>;',
  'node_modules/typeorm/index.d.ts': `
    export class EntityManager { query(sql: string): Promise<unknown>; transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T> }
    export class DataSource extends EntityManager {}
  `,
  'node_modules/@prisma/client/index.d.ts': `
    export class PrismaClient { user: { create(input: object): Promise<unknown> };
      $transaction<T>(run: (tx: PrismaClient) => Promise<T>): Promise<T> }
  `,
  'node_modules/axios/index.d.ts': `
    declare const axios: { post(url: string, body?: unknown): Promise<unknown> };
    export default axios;
  `,
  'node_modules/@types/node/index.d.ts': `
    declare module 'fs/promises' {
      export function writeFile(path: string, data: string): Promise<void>;
      export function readFile(path: string): Promise<string>;
    }
  `,
};

function check(source) {
  return lint(["import '@types/node';", source].join('\n'), files).filter(
    (finding) => finding.ruleId === 'external-call-in-transaction',
  );
}

test('reports fetch, axios and file writes awaited inside transaction callbacks', () => {
  const findings = check(
    [
      "import { DataSource } from 'typeorm';",
      "import { PrismaClient } from '@prisma/client';",
      "import axios from 'axios';",
      "import { writeFile } from 'fs/promises';",
      'declare const dataSource: DataSource; declare const prisma: PrismaClient;',
      'export async function run() {',
      '  await dataSource.transaction(async (manager) => {',
      "    await manager.query('select 1');",
      "    await fetch('https://example.test');",
      '  });',
      '  await prisma.$transaction(async (tx) => {',
      "    await axios.post('https://example.test');",
      "    await writeFile('a.txt', 'x');",
      '  });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 3);
});

test('reports a project method that reaches the call through two project hops', () => {
  const findings = check(
    [
      "import { DataSource } from 'typeorm';",
      'class Storage {',
      '  async store() { return this.upload(); }',
      "  private async upload() { return await fetch('https://example.test'); }",
      '}',
      'class Service {',
      '  constructor(private readonly dataSource: DataSource, private readonly storage: Storage) {}',
      '  async save() {',
      '    return this.dataSource.transaction(async (manager) => {',
      '      return await this.storage.store();',
      '    });',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /store\(\)/);
});

test('skips calls outside transactions, unawaited reads, and calls that receive the transaction client', () => {
  const findings = check(
    [
      "import { DataSource } from 'typeorm';",
      "import { readFile } from 'fs/promises';",
      'declare const dataSource: DataSource;',
      'async function helper(manager: unknown) { return await fetch("https://example.test"); }',
      'export async function run() {',
      "  await fetch('https://example.test');",
      '  await dataSource.transaction(async (manager) => {',
      "    await readFile('a.txt');",
      '    await helper(manager);',
      '  });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});

const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const fixHeader = ["import { DataSource } from 'typeorm';", 'declare const dataSource: DataSource;'];

function fixFor(context, bodyLines, extraLines = []) {
  const source = [...fixHeader, ...extraLines, 'export async function run(id: number) {', ...bodyLines, '}'].join('\n');
  const { findings } = scanWithFixes(context, {
    'globals.d.ts': files['globals.d.ts'],
    'node_modules/typeorm/index.d.ts': files['node_modules/typeorm/index.d.ts'],
    'a.ts': source,
  });
  return findings.filter((finding) => finding.ruleId === 'external-call-in-transaction');
}

test('moves a plain awaited call to after the transaction', (context) => {
  const [finding] = fixFor(context, [
    '  await dataSource.transaction(async (manager) => {',
    "    await manager.query('select 1');",
    '    await fetch(String(id));',
    '  });',
  ]);
  assert.match(finding.fix.note, /after the transaction commits/);
  assert.equal(onlyChange(finding).after, ['});', 'await fetch(String(id));'].join('\n'));
});

test('offers no fix when the call is not safe to move', (context) => {
  const cases = {
    'uses a callback local': [
      '  await dataSource.transaction(async (manager) => {',
      '    const key = String(id);',
      '    await fetch(key);',
      '  });',
    ],
    'result is used': [
      '  await dataSource.transaction(async (manager) => {',
      "    const ok = await fetch('https://example.test');",
      '    await manager.query(String(ok));',
      '  });',
    ],
    'inside an if': [
      '  await dataSource.transaction(async (manager) => {',
      '    if (id) {',
      '      await fetch(String(id));',
      '    }',
      '  });',
    ],
    'inside a loop': [
      '  await dataSource.transaction(async (manager) => {',
      '    for (const step of [1]) {',
      '      await fetch(String(id));',
      '    }',
      '  });',
    ],
    'inside a try': [
      '  await dataSource.transaction(async (manager) => {',
      '    try {',
      '      await fetch(String(id));',
      '    } catch {}',
      '  });',
    ],
    'later statement mentions its argument': [
      '  await dataSource.transaction(async (manager) => {',
      '    await fetch(String(id));',
      '    await manager.query(String(id));',
      '  });',
    ],
    'later statement calls something else': [
      '  await dataSource.transaction(async (manager) => {',
      '    await fetch(String(id));',
      "    await fetch('https://example.test');",
      '  });',
    ],
  };
  for (const [name, body] of Object.entries(cases)) {
    const findings = fixFor(context, body);
    assert.ok(findings.length >= 1, name);
    assert.equal(findings[0].fix, undefined, name);
  }
});

test('offers no fix when the call is reached through a helper', (context) => {
  const findings = fixFor(
    context,
    ['  await dataSource.transaction(async (manager) => {', '    await send();', '  });'],
    ["async function send() { await fetch('https://example.test'); }"],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fix, undefined);
});
