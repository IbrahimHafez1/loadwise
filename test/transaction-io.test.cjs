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
