'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const ioredisStub = `export class Redis {
  keys(pattern: string): Promise<string[]>;
  call(command: string, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  scanStream(options: object): AsyncIterable<string[]>;
  pipeline(): { keys(pattern: string): unknown };
}`;
const nodeRedisStub = `declare class RedisClient {
  keys(pattern: string): Promise<string[]>;
  sendCommand(args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}
export type RedisClientType = RedisClient & { extra: true };`;

function findingsFor(context, source, { nodeRedisMajor = 4 } = {}) {
  const { findings } = scanWithFixes(context, {
    'node_modules/ioredis/index.d.ts': ioredisStub,
    'node_modules/redis/index.d.ts': nodeRedisStub,
    'node_modules/redis/package.json': JSON.stringify({ name: 'redis', version: `${nodeRedisMajor}.7.0` }),
    'src/cache.ts': source,
  });
  return findings.filter((finding) => finding.ruleId === 'redis-keys-command');
}

test('ioredis keys() is replaced by a scanStream drain with the same variable', (context) => {
  const [finding] = findingsFor(
    context,
    `import { Redis } from 'ioredis';
declare const redis: Redis;
export async function purge(tenant: string) {
  const keys = await redis.keys(\`tenant:\${tenant}:*\`);
  return keys.length;
}`,
  );
  assert.deepEqual(onlyChange(finding), {
    before: 'const keys = await redis.keys(`tenant:${tenant}:*`);',
    after:
      'const keys: string[] = [];\nfor await (const batch of redis.scanStream({ match: `tenant:${tenant}:*`, count: 100 })) keys.push(...batch);',
  });
});

test('node-redis v4 yields single keys; v5 is reported without a rewrite', (context) => {
  const source = `import type { RedisClientType } from 'redis';
declare const client: RedisClientType;
export async function purge() {
  const keys = await client.keys('session:*');
  return keys;
}`;
  const [v4] = findingsFor(context, source);
  assert.equal(
    onlyChange(v4).after,
    "const keys: string[] = [];\nfor await (const key of client.scanIterator({ MATCH: 'session:*', COUNT: 100 })) keys.push(key);",
  );
  const [v5] = findingsFor(context, source, { nodeRedisMajor: 5 });
  assert.ok(v5);
  assert.equal(v5.fix, undefined);
});

test('raw KEYS commands report; other commands, pipelines and unrelated clients do not', (context) => {
  const findings = findingsFor(
    context,
    `import { Redis } from 'ioredis';
import type { RedisClientType } from 'redis';
declare const redis: Redis;
declare const client: RedisClientType;
declare const local: { keys(pattern: string): string[] };
export async function run() {
  await redis.call('KEYS', 'a:*');
  await client.sendCommand(['KEYS', 'b:*']);
  await redis.call('GET', 'a');
  await redis.get('a');
  redis.pipeline().keys('c:*');
  local.keys('d:*');
}`,
  );
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [7, 8],
  );
});
