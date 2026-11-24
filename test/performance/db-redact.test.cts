import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedactor, safeError, describeError, parseConnectionUrl } from '../../lib/performance/db/redact.cjs';

const user = 'sentinel_user';
const password = 'p@ss/w0rd:SENTINEL';
const host = 'sentinel-host.internal.example';
const url = `postgres://${user}:${encodeURIComponent(password)}@${host}:5432/app`;

test('parses user, decoded password, hosts and database from a connection URL', () => {
  assert.deepEqual(parseConnectionUrl(url), {
    scheme: 'postgres',
    user,
    rawUserInfo: `${user}:${encodeURIComponent(password)}`,
    password,
    hosts: [host],
    database: 'app',
  });
  const mongo = parseConnectionUrl('mongodb://u:p@h1.example:27017,[::1]:27018/shop?replicaSet=rs0');
  assert.ok(mongo);
  assert.deepEqual(mongo.hosts, ['h1.example', '::1']);
  assert.equal(mongo.database, 'shop');
  assert.equal(parseConnectionUrl('not a url'), undefined);
});

test('an unencoded @ in the password stays in the user info', () => {
  const parsed = parseConnectionUrl('mysql://root:a@b@db.local/app');
  assert.ok(parsed);
  assert.equal(parsed.password, 'a@b');
  assert.deepEqual(parsed.hosts, ['db.local']);
});

test('redacts the URL, user, password and host in raw, encoded and decoded forms', () => {
  const redact = createRedactor({ url, user, password, hosts: [host] });
  const text = [
    url,
    `password authentication failed for user "${user}"`,
    `getaddrinfo ENOTFOUND ${host}`,
    encodeURIComponent(password),
    password,
    'connect ECONNREFUSED 10.20.30.40:5432',
    'connect ECONNREFUSED ::1:5432',
    'other.internal.example',
  ].join('\n');
  const result = redact(text);
  for (const secret of [user, password, encodeURIComponent(password), host, '10.20.30.40', '::1', 'internal.example']) {
    assert.ok(!result.includes(secret), `leaked ${secret}`);
  }
  assert.match(result, /\[redacted\]/);
});

test('safe errors carry only the code and redacted message, never the stack or connection object', () => {
  const redact = createRedactor({ url, user, password, hosts: [host] });
  const error = Object.assign(new Error(`connect to ${url} failed`), {
    code: 'ECONNREFUSED',
    client: { connectionString: url },
  });
  error.stack = `Error: ${url}\n    at secret (${host})`;
  const safe = safeError(error, redact);
  assert.deepEqual(Object.keys(safe), ['code', 'message']);
  assert.equal(safe.code, 'ECONNREFUSED');
  assert.ok(!JSON.stringify(safe).includes(user));
  assert.equal(describeError(error, redact), 'ECONNREFUSED: connect to [redacted] failed');
  assert.equal(describeError('plain', redact), 'plain');
});

test('very short values are redacted as whole tokens, not inside other words', () => {
  const redact = createRedactor({ user: 'u', password: 'p', hosts: ['db'] });
  assert.equal(
    redact('password authentication failed for user "u" at db:5432 during production'),
    'password authentication failed for user "[redacted]" at [redacted]:5432 during production',
  );
});
