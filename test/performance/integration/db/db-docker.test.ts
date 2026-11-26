// Docker integration for `loadwise perf db`. Skipped unless BACKEND_PERF_DOCKER=1. Drivers come
// from ./fixture-project (installed there, never in this package), as they would from a user's
// project.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { run } from '../../../../lib/performance/db/cli.js';
import { loadSnapshot } from '../../../../lib/performance/schema/context.js';
import type { Finding } from '../../../../lib/shared/types.js';

const enabled = process.env.BACKEND_PERF_DOCKER === '1';
const fixtureProject = path.join(import.meta.dirname, 'fixture-project');
const repositoryRoot = path.join(import.meta.dirname, '..', '..', '..', '..');
const projectRequire = createRequire(path.join(fixtureProject, 'package.json'));
const password = 'Docker_Sentinel_Pw_31';
const readinessTimeoutMs = 120_000;
const pollIntervalMs = 1_000;
const suiteTimeoutMs = 300_000;

function docker(args: readonly string[]) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function startContainer(
  name: string,
  image: string,
  environment: Record<string, string>,
  containerPort: number,
  command: readonly string[] = [],
) {
  const environmentArgs = Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    ...environmentArgs,
    '-p',
    `127.0.0.1::${containerPort}`,
    image,
    ...command,
  ]);
  const mapping = docker(['port', name, String(containerPort)]).split('\n')[0];
  return Number(mapping.slice(mapping.lastIndexOf(':') + 1));
}

function removeContainer(name: string) {
  try {
    docker(['rm', '-f', name]);
  } catch {
    // Already gone.
  }
}

async function waitFor<Result>(probe: () => Promise<Result>): Promise<Result> {
  const deadline = Date.now() + readinessTimeoutMs;
  for (;;) {
    try {
      return await probe();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

async function runDb(argv: string[], env: NodeJS.ProcessEnv) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    env,
    cwd: fixtureProject,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function temporaryDirectory(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-db-docker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function assertNoSecrets(texts: readonly string[], secrets: readonly string[]) {
  for (const text of texts) {
    for (const secret of secrets) assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
}

test('PostgreSQL 18', { skip: !enabled && 'set BACKEND_PERF_DOCKER=1', timeout: suiteTimeoutMs }, async (t) => {
  const { Client } = projectRequire('pg');
  const name = `bpc-it-pg-${process.pid}`;
  const port = startContainer(name, 'postgres:18-alpine', { POSTGRES_PASSWORD: password, POSTGRES_DB: 'shop' }, 5432, [
    '-c',
    'shared_preload_libraries=pg_stat_statements',
  ]);
  t.after(() => removeContainer(name));
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/shop`;
  const admin = await waitFor(async () => {
    const client = new Client({ connectionString: url });
    client.on('error', () => {});
    await client.connect();
    return client;
  });
  t.after(() => admin.end());
  await admin.query(`
    CREATE EXTENSION pg_stat_statements;
    CREATE TABLE customers (id int PRIMARY KEY, email text NOT NULL UNIQUE);
    CREATE TABLE orders (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers (id),
      status text NOT NULL, total int NOT NULL, note text);
    CREATE INDEX orders_status_idx ON orders (status);
    CREATE INDEX orders_status_total_idx ON orders (status, total);
    CREATE INDEX orders_note_idx ON orders (note);
    CREATE TABLE events (id serial PRIMARY KEY, kind text NOT NULL, payload text);
    INSERT INTO customers SELECT g, 'c' || g || '@example.test' FROM generate_series(1, 300) g;
    INSERT INTO orders (customer_id, status, total)
      SELECT 1 + g % 300, (ARRAY['new', 'paid', 'shipped'])[1 + g % 3], g % 1000 FROM generate_series(1, 50000) g;
    INSERT INTO events (kind, payload) SELECT 'k' || g % 7, md5(g::text) FROM generate_series(1, 20000) g;
    ANALYZE;`);
  for (let index = 0; index < 12; index += 1)
    await admin.query('SELECT count(*) FROM events WHERE payload LIKE $1', ['%ab%']);
  for (let customer = 1; customer <= 5; customer += 1) {
    await admin.query('SELECT * FROM orders WHERE customer_id = $1', [customer]);
  }
  // Cumulative statistics are flushed lazily; force them out so the run sees the seq scans above.
  await admin.query('SELECT pg_stat_force_next_flush()');
  await admin.query('SELECT 1');
  const checksumSql = `SELECT
    (SELECT count(*) || ':' || sum(hashtext(c::text)) FROM customers c) AS customers,
    (SELECT count(*) || ':' || sum(hashtext(o::text)) FROM orders o) AS orders,
    (SELECT count(*) || ':' || sum(hashtext(e::text)) FROM events e) AS events,
    (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public') AS indexes`;
  const checksum = async () => (await admin.query(checksumSql)).rows[0];
  const before = await checksum();
  const env = { DATABASE_URL: url };
  const directory = temporaryDirectory(t);
  const queries = path.join(directory, 'queries.sql');
  fs.writeFileSync(queries, 'SELECT * FROM orders WHERE customer_id = 7;\n');
  const snapshotFile = path.join(directory, 'snapshot.json');

  await t.test('default run reports the seeded problems and writes a snapshot', async () => {
    const result = await runDb(['--include-contextual', '--schema-snapshot', snapshotFile], env);
    t.diagnostic('default run:\n' + result.stdout);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /^db:public\.orders \[db-unindexed-foreign-key\]/m);
    assert.match(result.stdout, /^db:public\.orders \[db-duplicate-index\] Index `orders_status_idx`/m);
    assert.match(result.stdout, /^db:public\.orders \[db-unused-index\] Index `orders_note_idx`.*\(Statistics cover/m);
    assert.match(result.stdout, /^db:public\.events \[db-seq-scan-heavy-table\]/m);
    assert.match(
      result.stdout,
      /^db:public\.orders \[db-slow-query-plan\] `SELECT \* FROM orders WHERE customer_id = \$1`/m,
    );
    assert.match(result.stdout, /^Note: HypoPG is not installed/m);
    assertNoSecrets([result.stdout, result.stderr, fs.readFileSync(snapshotFile, 'utf8')], [password, url]);
    const snapshot = loadSnapshot(snapshotFile);
    assert.equal(snapshot.dialect, 'postgres');
    assert.equal(snapshot.tables['public.orders'].rowEstimate, 50_000);
    assert.equal(snapshot.roundTrip?.kind, 'measured');
  });

  await t.test('--analyze runs EXPLAIN ANALYZE on --queries and changes nothing', async () => {
    const result = await runDb(['--analyze', '--queries', queries], env);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /queries\.sql:1:1 \[db-slow-query-plan\] This query plans a sequential scan/);
  });

  await t.test('--measure reports measured milliseconds and leaves no index behind', async () => {
    const result = await runDb(
      [
        '--measure',
        '--i-understand-this-locks-tables',
        '--queries',
        queries,
        '--runs',
        '3',
        '--ignore',
        'db-unused-index',
      ],
      env,
    );
    t.diagnostic('measure run:\n' + result.stdout + '\n' + result.stderr);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /SHARE lock on `public\.orders`/);
    assert.match(result.stdout, /queries\.sql:1:1 \[db-missing-index\] This query plans/);
    assert.match(
      result.stdout,
      /^ {2}Impact: [\d.,]+ ms measured -> [\d.,]+ ms measured; method: median of 3 EXPLAIN ANALYZE runs/m,
    );
    const leftovers = await admin.query(
      "SELECT indexname FROM pg_indexes WHERE indexname LIKE 'backend\\_perf\\_check\\_%'",
    );
    assert.deepEqual(leftovers.rows, []);
  });

  await t.test('4.2 (e): table checksums and the index list are unchanged after every mode', async () => {
    assert.deepEqual(await checksum(), before);
  });

  await t.test('4.6: SET TRANSACTION READ ONLY after DDL blocks writes in the same transaction', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('CREATE INDEX "backend_perf_check_probe" ON orders (total)');
      await admin.query('SET TRANSACTION READ ONLY');
      await assert.rejects(admin.query("INSERT INTO events (kind) VALUES ('x')"), { code: '25006' });
    } finally {
      await admin.query('ROLLBACK');
    }
    assert.deepEqual(await checksum(), before);
  });

  await t.test('I5: wrong password, closed port and DNS failure are redacted (URL and DB_* variables)', async () => {
    const closedPort = port + 1 === 65536 ? port - 1 : port + 1;
    const sentinelUser = 'sentinel_docker_user';
    const sentinelPassword = 'Sentinel_Docker_Pw_88';
    const sentinelHost = 'sentinel-dns-failure.invalid';
    const cases = [
      { DATABASE_URL: `postgres://postgres:${sentinelPassword}@127.0.0.1:${port}/shop` },
      { DATABASE_URL: `postgres://${sentinelUser}:${sentinelPassword}@127.0.0.1:${closedPort}/shop` },
      { DATABASE_URL: `postgres://${sentinelUser}:${sentinelPassword}@${sentinelHost}:5432/shop` },
      {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(port),
        DB_USER: sentinelUser,
        DB_PASSWORD: sentinelPassword,
        DB_NAME: 'shop',
      },
      {
        DB_HOST: sentinelHost,
        DB_PORT: '5432',
        DB_USERNAME: sentinelUser,
        DB_PASSWORD: sentinelPassword,
        DB_DATABASE: 'shop',
      },
    ];
    for (const caseEnv of cases) {
      const result = await runDb(['--json', '--engine', 'postgres'], caseEnv);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /^db failed: /);
      assertNoSecrets([result.stdout, result.stderr], [sentinelUser, sentinelPassword, sentinelHost, '127.0.0.1']);
    }
  });

  await t.test('the bin dispatches db to the same command', () => {
    const child = spawnSync(process.execPath, [path.join(repositoryRoot, 'bin', 'loadwise.js'), 'db', '--json'], {
      cwd: fixtureProject,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.engine, 'postgres');
    assert.ok(report.findings.some((finding: Finding) => finding.ruleId === 'db-unindexed-foreign-key'));
    assertNoSecrets([child.stdout, child.stderr], [password, url]);
  });
});

test('MySQL 8.4', { skip: !enabled && 'set BACKEND_PERF_DOCKER=1', timeout: suiteTimeoutMs }, async (t) => {
  const mysql = projectRequire('mysql2/promise');
  const name = `bpc-it-mysql-${process.pid}`;
  const port = startContainer(name, 'mysql:8.4', { MYSQL_ROOT_PASSWORD: password, MYSQL_DATABASE: 'school' }, 3306);
  t.after(() => removeContainer(name));
  const url = `mysql://root:${password}@127.0.0.1:${port}/school`;
  const admin = await waitFor(async () => {
    const connection = await mysql.createConnection({ uri: url, multipleStatements: true });
    await connection.query('SELECT 1');
    return connection;
  });
  t.after(() => admin.end());
  await admin.query(`
    CREATE TABLE lessons (id int PRIMARY KEY AUTO_INCREMENT, user_id int NOT NULL, slug varchar(40) UNIQUE,
      last_updated datetime NOT NULL, KEY user_idx (user_id), KEY user_updated_idx (user_id, last_updated));
    SET SESSION cte_max_recursion_depth = 30000;
    INSERT INTO lessons (user_id, slug, last_updated)
      WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 20000)
      SELECT n % 500, CONCAT('s', n), NOW() FROM g;
    ANALYZE TABLE lessons;`);
  for (let index = 0; index < 3; index += 1) await admin.query("SELECT * FROM lessons WHERE slug LIKE '%9%'");
  const checksum = async () =>
    (
      await admin.query(
        "SELECT COUNT(*) AS rows_total, SUM(CRC32(CONCAT_WS(',', id, user_id, slug))) AS crc FROM lessons",
      )
    )[0][0];
  const before = await checksum();
  const result = await runDb(['--include-contextual'], { DATABASE_URL: url });
  t.diagnostic('mysql run:\n' + result.stdout);
  assert.equal(result.code, 1, result.stderr);
  assert.match(
    result.stdout,
    /^db:school\.lessons \[db-duplicate-index\] Index `user_idx` \(user_id\) is covered by `user_updated_idx`/m,
  );
  assert.match(result.stdout, /\[db-slow-query-plan\] `SELECT \* FROM `lessons` WHERE `slug` LIKE \?`/);
  // The checksum query reads the whole table by design and has no WHERE clause to index.
  assert.ok(!result.stdout.includes('CRC32'));
  // Sample texts can hold literals and are never printed; only normalized digests are.
  assert.ok(!result.stdout.includes("'%9%'"));
  assertNoSecrets([result.stdout, result.stderr], [password, url]);
  assert.deepEqual(await checksum(), before);
  const wrong = await runDb([], { DATABASE_URL: `mysql://root:Wrong_Sentinel_Pw@127.0.0.1:${port}/school` });
  assert.equal(wrong.code, 2);
  assertNoSecrets([wrong.stderr], ['Wrong_Sentinel_Pw', '127.0.0.1']);
});

test('MongoDB 8', { skip: !enabled && 'set BACKEND_PERF_DOCKER=1', timeout: suiteTimeoutMs }, async (t) => {
  const { MongoClient } = projectRequire('mongodb');
  const name = `bpc-it-mongo-${process.pid}`;
  const port = startContainer(name, 'mongo:8', {}, 27017);
  t.after(() => removeContainer(name));
  const url = `mongodb://127.0.0.1:${port}/shop`;
  const admin = await waitFor(async () => {
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 2_000 });
    await client.connect();
    await client.db('shop').command({ ping: 1 });
    return client;
  });
  t.after(() => admin.close());
  const database = admin.db('shop');
  const orders = database.collection('orders');
  await orders.insertMany(
    Array.from({ length: 2_000 }, (_, index) => ({ customerId: index % 50, status: 'paid', total: index })),
  );
  await orders.createIndex({ customerId: 1 }, { name: 'customer_1' });
  await orders.createIndex({ customerId: 1, total: -1 }, { name: 'customer_1_total_-1' });
  await database.command({ profile: 1, slowms: 0 });
  await orders.find({ total: { $gt: 1_990 } }).toArray();
  const checksum = async () => ({
    count: await orders.countDocuments(),
    indexes: (await orders.indexes()).map((index: { name: string }) => index.name).sort(),
    profile: (await database.command({ profile: -1 })).was,
  });
  const before = await checksum();
  const result = await runDb(['--include-contextual'], { DATABASE_URL: url });
  t.diagnostic('mongo run:\n' + result.stdout);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^db:shop\.orders \[db-duplicate-index\] Index `customer_1`/m);
  assert.match(result.stdout, /\[mongo-collection-scan-observed\] \d+ profiled operations on `shop\.orders`/);
  // 4.2 (f): the profiler level is unchanged, as are documents and indexes.
  assert.deepEqual(await checksum(), before);
});
