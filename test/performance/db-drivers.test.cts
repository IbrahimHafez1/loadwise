import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { DbUsageError, resolveConnection, loadDriver, findProjectRoot } from '../../lib/performance/db/drivers.cjs';

const sentinelUrl = 'postgresql://sentinel_user:sentinel_password@sentinel-host:5432/shop';

function temporaryProject(t: TestContext, modules: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-db-drivers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"app"}');
  for (const [name, source] of Object.entries(modules)) {
    const directory = path.join(root, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    fs.writeFileSync(path.join(directory, 'index.js'), source);
  }
  return root;
}

test('takes the connection from DATABASE_URL and derives the engine from the scheme', () => {
  const connection = resolveConnection({ env: { DATABASE_URL: sentinelUrl } });
  assert.equal(connection.engine, 'postgres');
  assert.equal(connection.url, sentinelUrl);
  assert.deepEqual(connection.envVarNames, ['DATABASE_URL']);
  assert.equal(connection.databaseName, 'shop');
  assert.equal(connection.redact(`failed ${sentinelUrl} sentinel_password`), 'failed [redacted] [redacted]');
});

test('--url-env names another variable, and an unset named variable is a usage error', () => {
  const env = { STAGING_DB: 'mysql://u:p@h/app', DATABASE_URL: sentinelUrl };
  assert.equal(resolveConnection({ env, urlEnv: 'STAGING_DB' }).engine, 'mysql');
  assert.throws(() => resolveConnection({ env, urlEnv: 'MISSING_DB' }), DbUsageError);
});

test('falls back to DB_HOST style variables and redacts them too', () => {
  const env = {
    DB_HOST: 'sentinel-host',
    DB_PORT: '3306',
    DB_USERNAME: 'sentinel_user',
    DB_PASSWORD: 'sentinel_password',
    DB_DATABASE: 'school',
  };
  const connection = resolveConnection({ env });
  assert.equal(connection.engine, 'mysql');
  assert.deepEqual(connection.parts, {
    host: 'sentinel-host',
    port: '3306',
    user: 'sentinel_user',
    password: 'sentinel_password',
    database: 'school',
  });
  assert.deepEqual(connection.envVarNames, ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE']);
  assert.equal(connection.redact('sentinel_user@sentinel-host sentinel_password'), '[redacted]@[redacted] [redacted]');
  assert.throws(() => resolveConnection({ env: { DB_HOST: 'h', DB_PORT: '6000' } }), /--engine/);
  assert.equal(resolveConnection({ env: { DB_HOST: 'h' }, engine: 'postgres' }).engine, 'postgres');
});

test('--env-file is parsed without touching process.env', () => {
  const before = process.env.DATABASE_URL;
  const connection = resolveConnection({
    env: {},
    envFile: '.env.staging',
    readFile: (file) => {
      assert.equal(file, '.env.staging');
      return `# staging\nDATABASE_URL="${sentinelUrl}"\n`;
    },
  });
  assert.equal(connection.url, sentinelUrl);
  assert.equal(process.env.DATABASE_URL, before);
  assert.throws(
    () =>
      resolveConnection({
        env: {},
        envFile: 'x',
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    DbUsageError,
  );
});

test('usage errors never echo the connection values', () => {
  const unparseable = 'sentinel_password_without_scheme';
  const unsupported = 'redis://sentinel_user:sentinel_password@sentinel-host';
  for (const value of [unparseable, unsupported]) {
    assert.throws(
      () => resolveConnection({ env: { DATABASE_URL: value } }),
      (error) => error instanceof DbUsageError && !/sentinel/.test(error.message),
    );
  }
  assert.throws(() => resolveConnection({ env: { DATABASE_URL: sentinelUrl }, engine: 'mysql' }), /does not match/);
  assert.throws(() => resolveConnection({ env: {} }), /No connection/);
});

test('resolves the driver from the project, not from this package', (t) => {
  const root = temporaryProject(t, { pg: 'module.exports = { fromProject: true };' });
  assert.deepEqual(loadDriver('postgres', root), { fromProject: true });
  assert.equal(findProjectRoot(path.join(root, 'node_modules', 'pg')), path.join(root, 'node_modules', 'pg'));
  assert.equal(findProjectRoot(root), root);
});

test('uses mongoose.mongo when the mongodb package is not a direct dependency', (t) => {
  const root = temporaryProject(t, { mongoose: 'module.exports = { mongo: { MongoClient: "inner" } };' });
  // Node also resolves from parent directories, so a stray ~/node_modules/mongodb would win, as it
  // would for the app.
  const strayMongodb = (() => {
    try {
      return Boolean(createRequire(path.join(root, 'package.json')).resolve('mongodb'));
    } catch {
      return false;
    }
  })();
  if (strayMongodb) return t.skip('a parent directory of the temp folder has node_modules/mongodb');
  assert.deepEqual(loadDriver('mongo', root), { MongoClient: 'inner' });
});

test('a missing driver is a usage error naming the package', (t) => {
  const root = temporaryProject(t);
  assert.throws(
    () => loadDriver('postgres', root),
    (error) =>
      error instanceof DbUsageError &&
      error.message ===
        "`pg` is not installed in this project. `db` uses the project's own driver; install it there or run from the project root.",
  );
  assert.throws(() => loadDriver('mysql', root), /`mysql2` is not installed/);
});
