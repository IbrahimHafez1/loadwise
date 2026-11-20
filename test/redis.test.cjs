'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const { withProgram } = require('./helpers.cjs');
const { checkRedisCall } = require('../lib/redis.cjs');
const { isRepeated } = require('../lib/repeated.cjs');

const ioredisTypes = `
  export interface ChainableCommander {
    get(key: string): ChainableCommander;
    set(key: string, value: string): ChainableCommander;
    exec(): Promise<unknown[]>;
  }
  export class Redis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<'OK'>;
    hgetall(key: string): Promise<Record<string, string>>;
    sismember(key: string, member: string): Promise<number>;
    mget(...keys: string[]): Promise<(string | null)[]>;
    blpop(key: string, timeout: number): Promise<[string, string] | null>;
    pipeline(): ChainableCommander;
    multi(): ChainableCommander;
  }
  export class Cluster extends Redis {}
`;
const nodeRedisTypes = `
  declare class RedisClient {
    get(key: string): Promise<string | null>;
    hGet(key: string, field: string): Promise<string | undefined>;
    hGetAll(key: string): Promise<Record<string, string>>;
    sAdd(key: string, member: string): Promise<number>;
    multi(): { get(key: string): unknown; execAsPipeline(): Promise<unknown[]> };
  }
  export type RedisClientType = RedisClient & { extra: true };
  export function createClient(): RedisClientType;
`;
const unrelatedTypes = `export class Redis { get(key: string): Promise<string>; }`;
const files = {
  'node_modules/ioredis/index.d.ts': ioredisTypes,
  'node_modules/redis/index.d.ts': nodeRedisTypes,
  'node_modules/local-cache/index.d.ts': unrelatedTypes,
};

function findRedisFindings(source) {
  return withProgram(source, files, (program, sourceFile) => {
    const checker = program.getTypeChecker();
    const findings = [];
    const context = {
      checker,
      isRepeated: (node) => isRepeated(node, checker),
      report(node, ruleId, message) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({ ruleId, line: line + 1, message });
      },
    };
    (function visit(node) {
      if (ts.isCallExpression(node)) checkRedisCall(node, context);
      ts.forEachChild(node, visit);
    })(sourceFile);
    return findings;
  });
}

test('ioredis per-item commands report with the batch form of each command', () => {
  const findings = findRedisFindings(`import { Redis } from 'ioredis';
async function load(redis: Redis, ids: string[]) {
  for (const id of ids) await redis.get(id);
  await Promise.all(ids.map((id) => redis.sismember('members', id)));
  ids.forEach((id) => redis.hgetall(id));
}`);
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['redis-command-in-loop', 3],
      ['redis-command-in-loop', 4],
      ['redis-command-in-loop', 5],
    ],
  );
  assert.equal(
    findings[0].message,
    '`redis.get` runs once per item, one network round trip each. Batch them with `redis.mget(keys)`, or queue the commands on `redis.pipeline()` and `exec()` once. Ignore if each command depends on the previous reply.',
  );
  assert.match(findings[1].message, /redis\.smismember\(key, members\)/);
  assert.doesNotMatch(findings[2].message, /Batch them/);
  assert.match(
    findings[2].message,
    /^`redis\.hgetall` runs once per item.* Queue the commands on `redis\.pipeline\(\)`/,
  );
});

test('node-redis clients from createClient report with camelCase batch forms', () => {
  const findings = findRedisFindings(`import { createClient, type RedisClientType } from 'redis';
const client = createClient();
async function load(typed: RedisClientType, ids: string[]) {
  for (const id of ids) await client.hGet('users', id);
  for (const id of ids) await typed.sAdd('seen', id);
  for (const id of ids) await typed.hGetAll(id);
}`);
  assert.deepEqual(
    findings.map(({ line }) => line),
    [4, 5, 6],
  );
  assert.match(findings[1].message, /typed\.sAdd` runs once per item.*`typed\.sAdd\(key, members\)`/);
  assert.match(findings[2].message, /`typed\.multi\(\)` and `execAsPipeline\(\)`/);
});

test('redis ignores pipelines, multi chains, batch commands, blocking commands and single calls', () => {
  const findings = findRedisFindings(`import { Redis } from 'ioredis';
import { createClient } from 'redis';
const client = createClient();
async function safe(redis: Redis, ids: string[]) {
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(id);
  for (const id of ids) redis.multi().get(id);
  for (const id of ids) redis.pipeline().set(id, '1');
  for (const id of ids) client.multi().get(id);
  await redis.mget(...ids);
  for (const id of ids) await redis.blpop(id, 1);
  await redis.get('single');
}`);
  assert.deepEqual(findings, []);
});

test('redis ignores bounded retries, result-driven loops and look-alike clients', () => {
  const findings = findRedisFindings(`import { Redis } from 'ioredis';
import { Redis as LocalRedis } from 'local-cache';
async function sequential(redis: Redis, local: LocalRedis, ids: string[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await redis.get('lock');
      break;
    } catch {
      continue;
    }
  }
  let cursor: string | null = 'start';
  while (cursor) {
    const next = await redis.get(cursor);
    cursor = next;
  }
  for (const id of ids) await local.get(id);
  for (const id of ids) ({ get: (key: string) => key }).get(id);
}`);
  assert.deepEqual(findings, []);
});
