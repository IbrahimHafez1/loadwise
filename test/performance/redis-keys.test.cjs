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
  assert.equal(finding.fix.requiresReview, true);
  assert.match(finding.fix.note, /cursor steps/);
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

const redisHeader = `import { Redis } from 'ioredis';\ndeclare const redis: Redis;\ndeclare const tenant: string;\n`;

test('keys awaited inside an expression are collected on the line above', (context) => {
  const findings = findingsFor(
    context,
    `${redisHeader}export async function check() {
  expect(await redis.keys(\`a:\${tenant}:*\`)).toEqual([]);
  expect(await redis.keys('b:*')).toEqual([]);
}
declare function expect(value: unknown): { toEqual(expected: unknown): void };`,
  );
  assert.ok(findings.every((finding) => finding.fix.requiresReview));
  const [first, second] = findings.map(onlyChange);
  assert.equal(
    first.after,
    'const matchedKeys: string[] = [];\nfor await (const batch of redis.scanStream({ match: `a:${tenant}:*`, count: 100 })) matchedKeys.push(...batch);\nexpect(matchedKeys).toEqual([]);',
  );
  assert.match(second.after, /const matchedKeys2: string\[\] = \[\];/);
  assert.match(findings[0].fix.note, /SCAN/);
});

test('two keys in one spread list share one fix with distinct names', (context) => {
  const [first, second] = findingsFor(
    context,
    `${redisHeader}export async function purge() {
  const all = [...(await redis.keys('a:*')), ...(await redis.keys('b:*'))];
  return all;
}`,
  );
  assert.deepEqual(first.fix.changes, second.fix.changes);
  const { after } = onlyChange(first);
  assert.match(after, /matchedKeys\.push[\s\S]*matchedKeys2\.push/);
  assert.match(after, /const all = \[\.\.\.matchedKeys, \.\.\.matchedKeys2\];/);
});

test('a keys call returned from a map callback becomes an async collector', (context) => {
  const [finding] = findingsFor(
    context,
    `${redisHeader}export async function many(patterns: string[]) {
  return Promise.all(patterns.map((pattern) => redis.keys(pattern)));
}`,
  );
  const { after } = onlyChange(finding);
  assert.equal(finding.fix.requiresReview, true);
  assert.match(after, /patterns\.map\(async \(pattern\) => \{/);
  assert.match(
    after,
    /for await \(const batch of redis\.scanStream\(\{ match: pattern, count: 100 \}\)\) matchedKeys\.push\(\.\.\.batch\);/,
  );
  assert.match(after, /return matchedKeys;/);
});

test('keys that are only reached conditionally are left alone', (context) => {
  const [finding] = findingsFor(
    context,
    `${redisHeader}export async function maybe(on: boolean) {
  const keys = on && (await redis.keys('a:*'));
  return keys;
}`,
  );
  assert.ok(finding);
  assert.equal(finding.fix, undefined);
});
