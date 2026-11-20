'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { run } = require('../lib/db/cli.cjs');
const { DbUsageError } = require('../lib/db/drivers.cjs');
const { loadSnapshot } = require('../lib/schema/context.cjs');
const {
  createRecordingAdapter,
  createSignals,
  disallowedPostgresStatements,
  unbalancedTransactions,
} = require('./db-fake-driver.cjs');

const sentinel = { user: 'sentinel_user_9f2', password: 'sentinel_pw_7Kq', host: 'sentinel-host-4d1.internal.example' };
const sentinelUrl = `postgres://${sentinel.user}:${sentinel.password}@${sentinel.host}:5999/shop`;
const discreteEnv = {
  DB_HOST: sentinel.host,
  DB_PORT: '5432',
  DB_USER: sentinel.user,
  DB_PASSWORD: sentinel.password,
  DB_NAME: 'shop',
};

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-db-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const seqScan = [
  {
    Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Filter: '(customer_id = $1)', 'Total Cost': 48_210.5 },
  },
];
const indexScan = [
  { Plan: { 'Node Type': 'Index Scan', 'Index Name': '<16401>btree_orders_customer_id', 'Total Cost': 8.44 } },
];

function postgresResponses({ serverInfo = {}, extensions = ['pg_stat_statements', 'hypopg', 'plpgsql'] } = {}) {
  let hypothetical = false;
  return {
    serverInfo: [{ version_num: 180007, version: '18.7', database_name: 'shop', in_recovery: false, ...serverInfo }],
    extensions: extensions.map((name) => ({ name })),
    statsAge: [{ stats_age_days: '30.5' }],
    tables: [
      {
        schema_name: 'public',
        table_name: 'orders',
        row_estimate: '2400000',
        size_bytes: '9000000',
        seq_scan: '5',
        seq_tup_read: '9',
        idx_scan: '900',
        n_live_tup: '2400000',
      },
      { schema_name: 'public', table_name: 'customers', row_estimate: '300', size_bytes: '8192', n_live_tup: '300' },
    ],
    columns: ['id', 'customer_id', 'status'].map((column_name) => ({
      schema_name: 'public',
      table_name: 'orders',
      column_name,
    })),
    indexes: [
      {
        schema_name: 'public',
        table_name: 'orders',
        index_name: 'orders_pkey',
        method: 'btree',
        is_unique: true,
        is_primary: true,
        backs_constraint: true,
        predicate: null,
        key_columns: ['id'],
        key_definitions: ['id'],
        key_opclasses: ['int4_ops'],
        key_descending: [false],
        idx_scan: '900',
        size_bytes: '8192',
      },
    ],
    foreignKeys: [
      {
        schema_name: 'public',
        table_name: 'orders',
        constraint_name: 'orders_customer_id_fkey',
        columns: ['customer_id'],
        referenced_schema: 'public',
        referenced_table: 'customers',
        referenced_columns: ['id'],
      },
    ],
    topStatements: [
      {
        query_id: '1',
        query: 'SELECT * FROM orders WHERE customer_id = $1',
        calls: '1204',
        total_exec_time: 49_000,
        mean_exec_time: 40.7,
      },
      {
        query_id: '2',
        query: `ALTER USER ${sentinel.user} PASSWORD 'x'`,
        calls: '1',
        total_exec_time: 1,
        mean_exec_time: 1,
      },
    ],
    hypopgCreateIndex: () => {
      hypothetical = true;
      return [{ indexrelid: 16401, indexname: '<16401>btree_orders_customer_id' }];
    },
    hypopgReset: () => {
      hypothetical = false;
      return [{}];
    },
    explain: () => [{ 'QUERY PLAN': hypothetical ? indexScan : seqScan }],
    roundTrip: [{ '?column?': 1 }],
    indexesNamed: [{ remaining: 0 }],
  };
}

async function runDb(
  argv,
  {
    env = { DATABASE_URL: sentinelUrl },
    responses = postgresResponses(),
    connect,
    adapterEngine = 'postgres',
    cwd,
  } = {},
) {
  const stdout = [];
  const stderr = [];
  const signals = createSignals();
  const adapter = createRecordingAdapter({ engine: adapterEngine, responses });
  let connected = 0;
  const code = await run(argv, {
    env,
    cwd: cwd ?? process.cwd(),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    loadDriver: () => ({}),
    connect:
      connect ??
      (async () => {
        connected += 1;
        return adapter;
      }),
    signals,
    exit: signals.exit,
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), adapter, connected: () => connected };
}

function assertNoSentinels(...texts) {
  for (const text of texts) {
    for (const secret of [sentinel.user, sentinel.password, sentinel.host, sentinelUrl, 'internal.example']) {
      assert.ok(!text.includes(secret), `output leaked ${secret}:\n${text}`);
    }
  }
}

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await runDb(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /^Usage: backend-perf-check db/);
});

test('a URL passed as an argument or option is refused without echoing it', async () => {
  for (const argv of [[sentinelUrl], [`--url=${sentinelUrl}`], ['--top', sentinelUrl], ['--engine', sentinelUrl]]) {
    const { code, stdout, stderr, connected } = await runDb(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.equal(connected(), 0);
    assertNoSentinels(stdout, stderr);
  }
  assert.match((await runDb([sentinelUrl])).stderr, /pass the variable name: --url-env NAME/);
});

test('a full PostgreSQL run reports catalog and HypoPG-validated plan findings with Impact lines', async (t) => {
  const directory = temporaryDirectory(t);
  const snapshotFile = path.join(directory, 'snapshot.json');
  const { code, stdout, stderr, adapter } = await runDb(['--schema-snapshot', snapshotFile]);
  assert.equal(code, 1, stderr);
  assert.match(stdout, /^db:public\.orders \[db-unindexed-foreign-key\] Foreign key `orders_customer_id_fkey`/m);
  assert.match(
    stdout,
    /^db:public\.orders \[db-missing-index\] `SELECT \* FROM orders WHERE customer_id = \$1` \(1,204 calls, mean 41 ms measured by pg_stat_statements\)/m,
  );
  assert.match(
    stdout,
    /^ {2}Impact: ~48,211 planner cost estimated -> ~8 planner cost estimated; method: HypoPG hypothetical index, planner cost estimate\.$/m,
  );
  assert.match(
    stdout,
    /^postgres 18\.7: 2 finding\(s\)\. Round trip [\d.]+ ms measured from this host \(median of 20\)/m,
  );
  assert.ok(!stdout.includes('ALTER USER'));
  assertNoSentinels(stdout, stderr, fs.readFileSync(snapshotFile, 'utf8'));
  // 4.2 (a), (c), (d) over everything the run sent.
  assert.deepEqual(await disallowedPostgresStatements(adapter.sent), []);
  assert.ok(adapter.sent.every(({ text }) => !/ANALYZE/.test(text)));
  assert.equal(unbalancedTransactions(adapter.sent), false);
  assert.equal(adapter.closed, true);
  const loaded = loadSnapshot(snapshotFile);
  assert.equal(loaded.tables['public.orders'].rowEstimate, 2_400_000);
  assert.equal(loaded.roundTrip.runs, 20);
});

test('JSON output, --ignore and the contextual count', async () => {
  const { code, stdout } = await runDb([
    '--json',
    '--ignore',
    'db-missing-index',
    '--ignore',
    'db-unindexed-foreign-key',
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.findings, []);
  assert.equal(result.engine, 'postgres');
  assert.equal(result.roundTrip.kind, 'measured');
});

test('missing extensions become notes, and no millisecond impact is printed without a measurement', async () => {
  const { code, stdout } = await runDb([], { responses: postgresResponses({ extensions: ['plpgsql'] }) });
  assert.equal(code, 1);
  assert.match(stdout, /^Note: HypoPG is not installed/m);
  assert.match(stdout, /^Note: pg_stat_statements is not installed/m);
  assert.ok(!/Impact:/.test(stdout));
});

test('I5: connection failures never print the URL, user, password or host', async () => {
  const failures = [
    Object.assign(new Error(`connect ECONNREFUSED 10.9.8.7:5999`), { code: 'ECONNREFUSED', address: '10.9.8.7' }),
    Object.assign(new Error(`password authentication failed for user "${sentinel.user}"`), { code: '28P01' }),
    Object.assign(new Error(`getaddrinfo ENOTFOUND ${sentinel.host}`), { code: 'ENOTFOUND', hostname: sentinel.host }),
    Object.assign(new Error(`could not connect to ${sentinelUrl}`), { client: { password: sentinel.password } }),
  ];
  for (const env of [{ DATABASE_URL: sentinelUrl }, discreteEnv]) {
    for (const failure of failures) {
      failure.stack = `Error: ${sentinelUrl}\n    at connect (${sentinel.host})`;
      for (const json of [false, true]) {
        const { code, stdout, stderr } = await runDb(json ? ['--json'] : [], {
          env,
          connect: async () => {
            throw failure;
          },
        });
        assert.equal(code, 2);
        assert.match(stderr, /^db failed: /);
        assertNoSentinels(stdout, stderr);
      }
    }
  }
});

test('I5: errors raised after connecting are redacted too', async () => {
  const responses = {
    ...postgresResponses(),
    tables: () => {
      throw Object.assign(new Error(`permission denied for ${sentinel.user} on ${sentinel.host}`), { code: '42501' });
    },
  };
  const { code, stderr, adapter } = await runDb([], { env: discreteEnv, responses });
  assert.equal(code, 2);
  assert.match(stderr, /42501: permission denied for \[redacted\] on \[redacted\]/);
  assertNoSentinels(stderr);
  assert.equal(unbalancedTransactions(adapter.sent), false);
  assert.equal(adapter.destroyed, true);
});

test('a missing project driver is exit 2 with the install hint', async () => {
  const stderr = [];
  const code = await run([], {
    env: { DATABASE_URL: sentinelUrl },
    stdout: () => {},
    stderr: (line) => stderr.push(line),
    loadDriver: () => {
      throw new DbUsageError(
        "`pg` is not installed in this project. `db` uses the project's own driver; install it there or run from the project root.",
      );
    },
  });
  assert.equal(code, 2);
  assert.match(stderr.join('\n'), /`pg` is not installed in this project/);
});

test('--measure refusals happen before connecting', async (t) => {
  const queries = path.join(temporaryDirectory(t), 'queries.sql');
  fs.writeFileSync(queries, 'SELECT * FROM orders WHERE customer_id = 7;\n');
  const cases = [
    { argv: ['--measure'], pattern: /--measure needs --queries/ },
    { argv: ['--measure', '--queries', queries], pattern: /--i-understand-this-locks-tables/ },
    {
      argv: ['--measure', '--i-understand-this-locks-tables', '--queries', queries, '--url-env', 'PROD_DATABASE_URL'],
      env: { PROD_DATABASE_URL: sentinelUrl },
      pattern: /`PROD_DATABASE_URL`, whose name looks like production/,
    },
    {
      argv: ['--measure', '--i-understand-this-locks-tables', '--queries', queries],
      env: { DATABASE_URL: 'postgres://u:p@h/shop_prod' },
      pattern: /database whose name looks like production/,
    },
    {
      argv: ['--measure', '--i-understand-this-locks-tables', '--queries', queries],
      env: { DATABASE_URL: 'mysql://u:p@h/shop' },
      pattern: /PostgreSQL only/,
    },
  ];
  for (const { argv, env, pattern } of cases) {
    const result = await runDb(argv, env ? { env } : {});
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.stderr, pattern);
    assert.equal(result.connected(), 0);
  }
});

test('--measure refuses replicas and production databases reported by the server', async (t) => {
  const queries = path.join(temporaryDirectory(t), 'queries.sql');
  fs.writeFileSync(queries, 'SELECT * FROM orders WHERE customer_id = 7;\n');
  const argv = ['--measure', '--i-understand-this-locks-tables', '--queries', queries];
  for (const [serverInfo, pattern] of [
    [{ in_recovery: true }, /replica/],
    [{ database_name: 'production_copy' }, /production/],
  ]) {
    const { code, stderr, adapter } = await runDb(argv, { responses: postgresResponses({ serverInfo }) });
    assert.equal(code, 2);
    assert.match(stderr, pattern);
    assert.ok(adapter.sent.every(({ text }) => !text.startsWith('CREATE') && !text.includes('READ WRITE')));
  }
});

test('--measure times the query before and after and reports a measured Impact', async (t) => {
  const queries = path.join(temporaryDirectory(t), 'queries.sql');
  fs.writeFileSync(queries, '-- hot path\nSELECT * FROM orders WHERE customer_id = 7;\nDELETE FROM orders;\n');
  const responses = postgresResponses({ extensions: ['plpgsql'] });
  let indexBuilt = false;
  responses.explain = (params, text) => {
    if (text.startsWith('EXPLAIN (ANALYZE')) {
      const plan = indexBuilt ? indexScan : seqScan;
      return [
        {
          'QUERY PLAN': [
            {
              ...plan[0],
              Plan: { ...plan[0].Plan, 'Actual Rows': 3, 'Actual Loops': 1 },
              'Execution Time': indexBuilt ? 0.4 : 40,
            },
          ],
        },
      ];
    }
    return [{ 'QUERY PLAN': [{ Plan: { ...seqScan[0].Plan, Filter: '(customer_id = 7)' } }] }];
  };
  responses['BEGIN TRANSACTION READ WRITE'] = () => {
    indexBuilt = true;
    return [];
  };
  responses.ROLLBACK = () => {
    indexBuilt = false;
    return [];
  };
  const result = await runDb(['--measure', '--i-understand-this-locks-tables', '--queries', queries, '--runs', '3'], {
    responses,
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /SHARE lock on `public\.orders` that blocks writes/);
  assert.match(
    result.stdout,
    new RegExp(`^${queries.replace(/[\\.]/g, '\\$&')}:2:1 \\[db-missing-index\\] This query plans`, 'm'),
  );
  assert.match(
    result.stdout,
    /^ {2}Impact: 40 ms measured -> 0\.4 ms measured; method: median of 3 EXPLAIN ANALYZE runs, index built inside a rolled-back transaction\.$/m,
  );
  assert.match(result.stdout, /^ {2}Measured: rows examined/m);
  assert.match(result.stdout, /:3 is not a SELECT and was skipped/);
  assert.deepEqual(await disallowedPostgresStatements(result.adapter.sent, { allowMeasure: true }), []);
  assert.equal(unbalancedTransactions(result.adapter.sent), false);
  assert.ok(result.adapter.sent.some(({ text }) => text.includes('pg_class WHERE relkind')));
});

test('an unreadable --env-file is a usage error that names no values', async () => {
  const { code, stderr, connected } = await runDb(['--env-file', 'missing.env'], { env: {} });
  assert.equal(code, 2);
  assert.equal(stderr, 'Could not read the --env-file.');
  assert.equal(connected(), 0);
});
