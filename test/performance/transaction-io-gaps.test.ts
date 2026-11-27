import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const files = {
  'node_modules/got/index.d.ts': `declare const got: { post(url: string): Promise<{ body: string }> }; export default got;`,
  'node_modules/mongoose/index.d.ts': `
    export class ClientSession { withTransaction<T>(run: (session: ClientSession) => Promise<T>): Promise<T> }
  `,
  'node_modules/@mikro-orm/core/index.d.ts': `
    export class EntityManager { transactional<T>(run: (em: EntityManager) => Promise<T>): Promise<T> }
  `,
  'node_modules/pg/index.d.ts': `
    export class PoolClient { query(sql: string): Promise<unknown> }
  `,
  'node_modules/other/index.d.ts': `
    export class Session { withTransaction<T>(run: (session: Session) => Promise<T>): Promise<T> }
  `,
  'globals.d.ts': 'declare function fetch(url: string): Promise<{ ok: boolean }>;',
};

function check(source: string) {
  return lint(source, files).filter((finding: Finding) => finding.ruleId === 'external-call-in-transaction');
}

test('reports an HTTP client call inside a Mongoose withTransaction callback', () => {
  const findings = check(
    [
      "import { ClientSession } from 'mongoose';",
      "import got from 'got';",
      'declare const session: ClientSession;',
      'export async function run() {',
      '  await session.withTransaction(async () => {',
      "    await got.post('https://example.test');",
      '  });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /got/);
});

test('reports fetch inside a MikroORM transactional callback', () => {
  const findings = check(
    [
      "import { EntityManager } from '@mikro-orm/core';",
      'declare const em: EntityManager;',
      'export async function run() {',
      '  await em.transactional(async () => {',
      "    await fetch('https://example.test');",
      '  });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
});

test('ignores withTransaction on a type from an unrelated package', () => {
  const findings = check(
    [
      "import { Session } from 'other';",
      'declare const session: Session;',
      'export async function run() {',
      '  await session.withTransaction(async () => {',
      "    await fetch('https://example.test');",
      '  });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});

test('reports fetch between BEGIN and COMMIT on a pg client and not after COMMIT', () => {
  const findings = check(
    [
      "import { PoolClient } from 'pg';",
      'export async function run(client: PoolClient) {',
      "  await client.query('BEGIN');",
      "  await fetch('https://inside.test');",
      "  await client.query('COMMIT');",
      "  await fetch('https://after.test');",
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
});

test('reports an HTTP call reached through a project helper inside a pg transaction', () => {
  const findings = check(
    [
      "import { PoolClient } from 'pg';",
      "import got from 'got';",
      "async function notify() { return await got.post('https://example.test'); }",
      'export async function run(client: PoolClient) {',
      "  await client.query('BEGIN');",
      '  await notify();',
      "  await client.query('COMMIT');",
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /notify\(\)/);
});
