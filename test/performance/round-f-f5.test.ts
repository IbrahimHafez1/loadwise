import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const ioredisTypes = `
  export interface ChainableCommander {
    incr(key: string): ChainableCommander;
    expire(key: string, seconds: number): ChainableCommander;
    exec(): Promise<unknown[]>;
  }
  export class Redis {
    incr(key: string): Promise<number>;
    incrby(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    pexpire(key: string, milliseconds: number): Promise<number>;
    multi(): ChainableCommander;
  }
`;
const redisFiles = {
  'node_modules/ioredis/index.d.ts': ioredisTypes,
  'node_modules/local-cache/index.d.ts': ioredisTypes,
};

function ruleFindings(findings: Finding[], ruleId: string) {
  return findings
    .filter((finding: Finding) => finding.ruleId === ruleId)
    .map(({ line, message }) => ({ line, message }));
}

test('an increment gated or followed by an expire on the same key reports once at the increment', () => {
  const findings = lint(
    `import { Redis } from 'ioredis';
export class Lockout {
  constructor(private readonly redis: Redis) {}
  async bump(key: string) {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, 60_000);
    if (count >= 5) await this.redis.pexpire(key, 600_000);
    return count;
  }
}
export async function hit(redis: Redis, ip: string) {
  await redis.incrby(\`rate:\${ip}\`, 1);
  await redis.expire(\`rate:\${ip}\`, 60);
}`,
    redisFiles,
  );
  const reported = ruleFindings(findings, 'redis-incr-then-expire');
  assert.deepEqual(
    reported.map(({ line }) => line),
    [5, 12],
  );
  assert.equal(
    reported[0].message,
    "`redis.incr` and the later `redis.pexpire` on the same key are two round trips and not atomic: if the process stops or the second command fails in between, the key keeps its count with no TTL and never resets. Send both in one `redis.multi().incr(key).pexpire(key, ttl, 'NX').exec()` (`NX` needs Redis 7 and keeps the TTL of the first increment), or run both in one Lua script. Caveat: the counter value then comes from the `exec()` reply.",
  );
  assert.equal(findings.find((finding: Finding) => finding.ruleId === 'redis-incr-then-expire')?.fix, undefined);
});

test('other keys, other clients, pipelines and unrelated packages stay quiet', () => {
  const findings = lint(
    `import { Redis } from 'ioredis';
import { Redis as LocalCache } from 'local-cache';
export async function quiet(redis: Redis, other: Redis, cache: LocalCache, key: string, otherKey: string) {
  await redis.incr(key);
  await redis.expire(otherKey, 60);
  await other.expire(key, 60);
  await redis.multi().incr(key).expire(key, 60).exec();
  await cache.incr(key);
  await cache.expire(key, 60);
}
export async function expireFirst(redis: Redis, key: string) {
  await redis.expire(key, 60);
  return redis.incr(key);
}`,
    redisFiles,
  );
  assert.deepEqual(ruleFindings(findings, 'redis-incr-then-expire'), []);
});

const serviceSource = `import { CryptoRepository } from './main';
export class AuthService {
  constructor(private readonly crypto: CryptoRepository) {}
  async login(password: string, stored: string) {
    return this.crypto.compareBcrypt(password, stored);
  }
}
`;

test('a sync bcrypt helper called from an async caller in another file reports, even without bcrypt types', () => {
  const findings = lint(
    `import { compareSync } from 'bcrypt';
export class CryptoRepository {
  compareBcrypt(data: string, encrypted: string) {
    return compareSync(data, encrypted);
  }
}`,
    { 'service.ts': serviceSource },
  );
  const [finding] = ruleFindings(findings, 'password-hash-sync-in-async');
  assert.equal(finding.line, 4);
  assert.equal(
    finding.message,
    '`compareSync` runs inside the sync helper `compareBcrypt`, which `login` (service.ts:5) calls on a request path, so it blocks the event loop for the whole hash (about 50–100 ms at cost 10), stalling every other request. Make `compareBcrypt` async with `await bcrypt.compare(password, hash)` and await it at each caller.',
  );
});

test('a private sync scrypt helper called from async middleware reports under the crypto rule', () => {
  const findings = lint(`import crypto from 'node:crypto';
function sessionHash(secret: string, id: string): string {
  return crypto.scryptSync(secret, id, 32).toString('hex');
}
export async function startFlow(secret: string, id: string) {
  return { hash: sessionHash(secret, id) };
}`);
  const reported = ruleFindings(findings, 'node-sync-crypto-in-async');
  assert.deepEqual(
    reported.map(({ line }) => line),
    [3],
  );
  assert.match(reported[0].message, /Make `sessionHash` async with `await promisify\(crypto\.scrypt\)/);
});

test('sync helpers with only sync, test or no callers stay quiet', () => {
  const findings = lint(
    `import crypto from 'node:crypto';
import * as bcrypt from 'bcrypt';
export function seedHash(password: string) {
  return bcrypt.hashSync(password, 10);
}
function derive(secret: string) {
  return crypto.pbkdf2Sync(secret, 'salt', 1000, 32, 'sha256');
}
export function startup(secret: string) {
  return [derive(secret), seedHash(secret)];
}`,
    { 'main.test.ts': `import { seedHash } from './main';\nexport async function run() { return seedHash('x'); }\n` },
  );
  assert.deepEqual(
    findings.filter(({ ruleId }) => ['password-hash-sync-in-async', 'node-sync-crypto-in-async'].includes(ruleId)),
    [],
  );
});
