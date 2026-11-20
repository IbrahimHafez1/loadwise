'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectTraces } = require('../../lib/performance/traces.cjs');

function analyzeTraces(document, options) {
  return inspectTraces(document, options).findings;
}

const TRACE_ID = 'eb1cb651c7564c96a743b9304d229afe';
const PARENT_ID = '0200000000000000';

function attributes(values) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === 'number' ? { intValue: value } : { stringValue: value },
  }));
}

function span(index, values, fields = {}) {
  return {
    traceId: TRACE_ID,
    parentSpanId: PARENT_ID,
    spanId: index.toString(16).padStart(16, '0'),
    name: 'private-span-name',
    kind: 3,
    attributes: attributes(values),
    ...fields,
  };
}

function resource(spans, values = {}) {
  return { resource: { attributes: attributes(values) }, scopeSpans: [{ spans }] };
}

const postgres = {
  'db.system': 'postgresql',
  'db.name': 'private-db',
  'net.peer.name': 'private-host',
  'db.statement': 'SELECT email FROM private_table WHERE customer_id = %s',
  'db.query.summary': 'SELECT private_table',
};
const mongo = {
  'db.system.name': 'mongodb',
  'db.namespace': 'app',
  'db.operation.name': 'find',
  'db.collection.name': 'private-collection',
};

test('groups Python/Postgres and JS/MongoDB requests by observed sibling operation', () => {
  const python = resource(
    Array.from({ length: 5 }, (_, index) =>
      span(index + 1, {
        ...postgres,
        'db.query.parameter.0': `private-value-${index}`,
      }),
    ),
    { 'service.name': 'private-api', 'telemetry.sdk.language': 'python' },
  );
  const javascript = resource(
    Array.from({ length: 6 }, (_, index) => span(index + 10, mongo)),
    {
      'service.name': 'private-api',
      'telemetry.sdk.language': 'nodejs',
    },
  );
  const findings = analyzeTraces({ resourceSpans: [python, javascript] });
  assert.deepEqual(
    findings.map(({ system, count }) => [system, count]),
    [
      ['postgresql', 5],
      ['mongodb', 6],
    ],
  );
  assert.deepEqual(
    Object.keys(findings[0]).sort(),
    ['ruleId', 'traceId', 'parentSpanId', 'exampleSpanId', 'count', 'system', 'message'].sort(),
  );
  assert.equal(findings[0].exampleSpanId, '0000000000000001');
  assert.doesNotMatch(JSON.stringify(findings), /private|SELECT|%s|email/);
});

test('exact statement text takes precedence over a shared coarse summary', () => {
  const differentText = { ...postgres, 'db.statement': 'SELECT name FROM private_table WHERE customer_id = %s' };
  assert.deepEqual(
    analyzeTraces({ resourceSpans: [resource([span(1, postgres), span(2, differentText)])] }, { threshold: 2 }),
    [],
  );
});

test('separates traces, parent spans, database namespaces, hosts, ports and operations', () => {
  const base = { ...mongo, 'server.port': 27017, 'server.address': 'one' };
  const spans = [
    span(1, base),
    span(2, { ...base, 'server.address': 'two' }),
    span(3, { ...base, 'server.port': 27018 }),
    span(4, { ...base, 'db.namespace': 'another' }),
    span(5, { ...base, 'db.operation.name': 'aggregate' }),
    span(6, { ...base, 'db.collection.name': 'another' }),
    span(7, base, { parentSpanId: '0000000000000009' }),
    span(8, base, { traceId: 'f'.repeat(32) }),
    span(9, base, { kind: 2 }),
    span(10, base, { parentSpanId: '' }),
    span(11, base, { parentSpanId: '0'.repeat(16) }),
    span(12, base, { parentSpanId: undefined }),
  ];
  assert.deepEqual(analyzeTraces({ resourceSpans: [resource(spans)] }, { threshold: 2 }), []);
});

test('deduplicates repeated span IDs and splits different services, merging matching resources across batches', () => {
  const first = resource([span(1, mongo), span(2, mongo)], { 'service.name': 'web', 'service.instance.id': 'one' });
  const second = resource([span(2, mongo), span(3, mongo)], { 'service.instance.id': 'one', 'service.name': 'web' });
  const other = resource([span(4, mongo)], { 'service.instance.id': 'one', 'service.name': 'other' });
  other.scopeSpans[0].spans.push(span(5, mongo, { kind: 2 }));
  const {
    findings: [finding],
    scannedSpans,
    eligibleDbSpans,
  } = inspectTraces({ resourceSpans: [first, second, other] }, { threshold: 2 });
  assert.equal(scannedSpans, 6);
  assert.equal(eligibleDbSpans, 4);
  assert.equal(finding.count, 3);
});

test('supports a summary without statement text and redacts custom DB systems', () => {
  const db = { 'db.system.name': 'private-system', 'db.query.summary': 'GET private-table' };
  const spans = [span(1, db, { kind: undefined }), span(2, db, { kind: 0 })];
  const [finding] = analyzeTraces({ resourceSpans: [resource(spans)] }, { threshold: 2 });
  assert.equal(finding.system, 'other');
  assert.doesNotMatch(JSON.stringify(finding), /private/);
  for (const summary of ['', 'SELECT']) {
    const broad = { ...db, 'db.query.summary': summary };
    assert.deepEqual(
      analyzeTraces({ resourceSpans: [resource([span(1, broad), span(2, broad)])] }, { threshold: 2 }),
      [],
    );
  }
});

test('valid empty exports pass and malformed input returns a redacted error', () => {
  assert.deepEqual(inspectTraces({ resourceSpans: [] }), { scannedSpans: 0, eligibleDbSpans: 0, findings: [] });
  assert.deepEqual(inspectTraces({ resourceSpans: [resource([span(1, { 'http.request.method': 'GET' })])] }), {
    scannedSpans: 1,
    eligibleDbSpans: 0,
    findings: [],
  });
  const illegal = [
    null,
    {},
    [],
    { resourceSpans: {} },
    { resourceSpans: [{}] },
    { resourceSpans: [{ scopeSpans: [{}] }] },
    { resourceSpans: [{ scopeSpans: [{ spans: ['private'] }] }] },
  ];
  for (const change of [
    { traceId: 'private' },
    { traceId: '0'.repeat(32) },
    { spanId: 'private' },
    { parentSpanId: 'private' },
    { kind: 'private' },
    { attributes: {} },
    { attributes: [{ key: 'private', value: 'private' }] },
    { attributes: [{ key: 'private', value: { raw: 'private' } }] },
  ]) {
    illegal.push({ resourceSpans: [resource([span(1, postgres, change)])] });
  }
  for (const document of illegal)
    assert.throws(
      () => analyzeTraces(document),
      (error) => error instanceof TypeError && !error.message.includes('private'),
    );
  for (const threshold of [1, 2.5, Infinity, '5'])
    assert.throws(() => analyzeTraces({ resourceSpans: [] }, { threshold }), RangeError);
});

test('late malformed and duplicate attributes invalidate the whole scan, including a non-DB span', () => {
  const repeated = Array.from({ length: 12 }, (_, index) => span(index + 1, postgres));
  const invalidAttributes = [
    [...attributes({ 'http.route': '/private' }), ...attributes({ 'http.route': '/private' })],
    [{ key: 'private-key', value: { arrayValue: { values: [{ boolValue: 'private' }] } } }],
  ];
  for (const invalid of invalidAttributes) {
    const last = span(13, {}, { kind: 1, attributes: invalid });
    assert.throws(() => inspectTraces({ resourceSpans: [resource([...repeated, last])] }), TypeError);
  }
});

test('long statements and many distinct shapes keep correct grouping after cache eviction', () => {
  const text = 'SELECT ' + 'column_name, '.repeat(300) + 'id FROM orders';
  const longStatement = { ...postgres, 'db.statement': text };
  const spans = [span(1, postgres), span(2, longStatement)];
  for (let index = 0; index < 160; index++)
    spans.push(span(index + 3, { ...mongo, 'db.collection.name': `collection-${index}` }));
  spans.push(span(200, postgres), span(201, longStatement));
  const result = inspectTraces({ resourceSpans: [resource(spans)] }, { threshold: 2 });
  assert.deepEqual(
    result.findings.map((finding) => finding.count),
    [2, 2],
  );
  assert.equal(result.eligibleDbSpans, spans.length);
  assert.doesNotMatch(JSON.stringify(result), /column_name|orders|private/);
});

test('Redis and Valkey KEYS report once per parent regardless of frequency or naming generation', () => {
  const spans = [
    span(1, { 'db.system': 'redis', 'db.statement': 'KEYS private:*' }),
    span(2, { 'db.system.name': 'redis', 'db.operation.name': 'keys' }),
    span(3, { 'db.system.name': 'valkey' }, { name: 'KEYS' }),
    span(4, { 'db.system.name': 'redis', 'db.operation.name': 'HKEYS' }),
    span(5, { 'db.system.name': 'redis', 'db.operation.name': 'SCAN' }),
    span(6, { 'db.system.name': 'mysql', 'db.statement': 'KEYS private' }),
  ];
  const result = inspectTraces({ resourceSpans: [resource(spans)] }, { threshold: 100 });
  assert.deepEqual(
    result.findings.map((finding) => [finding.ruleId, finding.count, finding.system]),
    [
      ['redis-keys-scan', 2, 'redis'],
      ['redis-keys-scan', 1, 'valkey'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /private/);
  for (const parentSpanId of [undefined, '', '0'.repeat(16)]) {
    const root = span(7, { 'db.system': 'redis', 'db.statement': 'KEYS private:*' }, { parentSpanId });
    const { findings } = inspectTraces({ resourceSpans: [resource([root])] });
    assert.deepEqual(
      findings.map((finding) => [finding.parentSpanId, finding.ruleId]),
      [['', 'redis-keys-scan']],
    );
  }
});

test('groups changing Redis keys separately by command, database index, server and parent', () => {
  const legacy = { 'db.system': 'redis', 'db.redis.database_index': 2, 'net.peer.name': 'private-host' };
  const stable = { 'db.system.name': 'redis', 'db.namespace': '2', 'server.address': 'private-host' };
  const spans = [
    span(1, { ...legacy, 'db.statement': 'GET private:one' }),
    span(2, { ...stable, 'db.query.text': 'get private:two' }),
    span(3, stable, { name: 'redis-GET' }),
    span(4, { ...legacy, 'db.statement': 'HGET private:three field' }),
    span(5, { ...stable, 'db.operation.name': 'hget' }),
    span(6, { ...stable, 'db.operation.name': 'HGET' }, { parentSpanId: 'ff'.repeat(8) }),
    span(7, { ...legacy, 'db.statement': 'GET private:four', 'db.redis.database_index': 3 }),
    span(8, { ...stable, 'db.operation.name': 'GET', 'server.address': 'other' }),
  ];
  const result = inspectTraces({ resourceSpans: [resource(spans)] }, { threshold: 2 });
  assert.deepEqual(
    result.findings.map((finding) => [finding.ruleId, finding.count]),
    [
      ['redis-repeated-read', 3],
      ['redis-repeated-read', 2],
    ],
  );
  assert.match(result.findings[0].message, /mGet\(keys\)/);
  assert.match(result.findings[1].message, /hmGet\(key, fields\)/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('skips known Redis pipelines, transactions, compound reads and cursor scans', () => {
  const base = { 'db.system.name': 'redis' };
  for (const marker of [
    { 'db.operation.name': 'PIPELINE GET' },
    { 'db.statement': 'MULTI' },
    { 'db.operation.name': 'GET', 'db.operation.batch.size': 4 },
    { 'db.redis.pipeline_length': 3 },
  ]) {
    const batch = span(1, { ...base, ...marker }, { parentSpanId: '' });
    const reads = Array.from({ length: 6 }, (_, index) =>
      span(index + 2, { ...base, 'db.operation.name': 'GET' }, { parentSpanId: batch.spanId }),
    );
    for (const spans of [
      [batch, ...reads],
      [...reads, batch],
    ]) {
      assert.deepEqual(inspectTraces({ resourceSpans: [resource(spans)] }), {
        scannedSpans: 7,
        eligibleDbSpans: 0,
        findings: [],
      });
    }
  }
  for (const operation of ['SCAN', 'SSCAN', 'ZSCAN', 'HSCAN', 'MGET', 'HMGET']) {
    const spans = Array.from({ length: 6 }, (_, index) =>
      span(index + 1, { ...base, 'db.query.text': `${operation} private` }),
    );
    assert.equal(inspectTraces({ resourceSpans: [resource(spans)] }).findings.length, 0);
  }
});

test('language-neutral fixtures cover parameterized SQL, NoSQL operations and custom database systems', () => {
  const cases = [
    ['java', 'mysql', { 'db.system.name': 'mysql', 'db.query.text': 'SELECT id FROM t WHERE id=?' }],
    ['dotnet', 'microsoft.sql_server', { 'db.system.name': 'microsoft.sql_server', 'db.query.summary': 'SELECT t' }],
    [
      'go',
      'cassandra',
      {
        'db.system': 'cassandra',
        'db.operation': 'SELECT',
        'db.cassandra.table': 't',
        'db.cassandra.keyspace': 'shop',
      },
    ],
    ['python', 'postgresql', postgres],
    ['nodejs', 'mongodb', mongo],
    ['ruby', 'sqlite', { 'db.system': 'sqlite', 'db.statement': 'select * from t where id=?' }],
    [
      'php',
      'aws.dynamodb',
      { 'db.system.name': 'aws.dynamodb', 'db.operation.name': 'GetItem', 'db.collection.name': 't' },
    ],
    ['rust', 'other', { 'db.system.name': 'custom', 'db.operation.name': 'get', 'db.collection.name': 't' }],
    ['java', 'mongodb', { 'db.system.name': 'mongodb', 'db.namespace': 'shop', 'db.operation.name': 'find' }],
  ];
  for (const [language, system, values] of cases) {
    const spans = Array.from({ length: 5 }, (_, index) => span(index + 1, values));
    const result = inspectTraces({ resourceSpans: [resource(spans, { 'telemetry.sdk.language': language })] });
    assert.equal(result.eligibleDbSpans, 5);
    assert.deepEqual(
      result.findings.map((finding) => [finding.system, finding.ruleId]),
      [[system, 'repeated-db-span']],
    );
  }
  for (const values of [
    { 'db.system.name': 'postgresql', 'db.operation.name': 'SELECT', 'db.namespace': 'shop' },
    { 'db.system.name': 'mongodb', 'db.operation.name': 'find' },
  ]) {
    assert.equal(
      inspectTraces({ resourceSpans: [resource([span(1, values), span(2, values)])] }, { threshold: 2 })
        .eligibleDbSpans,
      0,
    );
  }
});

test('AWS DynamoDB GetItem groups by actual table and region for legacy RPC and DB conventions', () => {
  const rpc = {
    'rpc.service': 'DynamoDB',
    'rpc.system': 'aws-api',
    'rpc.method': 'GetItem',
    'cloud.region': 'us-east-1',
  };
  const stable = { 'db.system.name': 'aws.dynamodb', 'cloud.region': 'us-east-1' };
  function getItem(index, attrs, table) {
    const values = attributes(attrs);
    values.push({ key: 'aws.dynamodb.table_names', value: { arrayValue: { values: [{ stringValue: table }] } } });
    return span(index, {}, { attributes: values, name: 'DynamoDB.GetItem' });
  }
  const spans = [
    getItem(1, rpc, 'private'),
    getItem(2, stable, 'private'),
    getItem(3, rpc, 'different'),
    getItem(4, { ...rpc, 'cloud.region': 'eu-west-1' }, 'private'),
    getItem(5, { ...rpc, 'rpc.service': 'S3' }, 'private'),
  ];
  const { findings, eligibleDbSpans } = inspectTraces({ resourceSpans: [resource(spans)] }, { threshold: 2 });
  assert.equal(eligibleDbSpans, 4);
  assert.deepEqual(
    findings.map(({ system, count }) => [system, count]),
    [['aws.dynamodb', 2]],
  );
});

const redisKeyRead = {
  'db.system.name': 'redis',
  'db.namespace': '0',
  'server.address': 'private-host',
  'db.query.text': 'GET private:customer:103',
};
const sqlKeyRead = {
  'db.system.name': 'postgresql',
  'db.namespace': 'shop',
  'server.address': 'private-host',
  'db.query.text': 'SELECT name, email FROM shop.customers WHERE id = $1;',
  'db.query.parameter.0': 103,
};

function cacheFindings(spans, threshold = 5) {
  return inspectTraces({ resourceSpans: [resource(spans)] }, { threshold }).findings;
}

test('same Redis key or simple bound SQL lookup gets request-local advice with no key or parameter in output', () => {
  for (const read of [redisKeyRead, sqlKeyRead]) {
    const spans = Array.from({ length: 5 }, (_, index) => span(index + 1, read));
    const findings = cacheFindings([...spans, spans[0]]);
    assert.deepEqual(
      findings.map(({ ruleId, count }) => [ruleId, count]),
      [['duplicate-key-read', 5]],
    );
    assert.match(findings[0].message, /reuse it/);
    assert.doesNotMatch(JSON.stringify(findings), /private|103|customers|email|SELECT/);
    assert.equal(cacheFindings([spans[0], spans[1]], 50)[0].count, 2);
  }
  const mixed = [
    span(1, redisKeyRead),
    span(2, redisKeyRead),
    span(3, { ...redisKeyRead, 'db.query.text': 'GET private:other' }),
  ];
  assert.deepEqual(
    cacheFindings(mixed, 3).map((finding) => finding.ruleId),
    ['duplicate-key-read', 'redis-repeated-read'],
  );
});

test('different bind values, identity, parent, database, or server do not share cache candidates', () => {
  for (const change of [
    { 'db.query.parameter.0': 104 },
    { 'db.query.parameter.0': '103' },
    { 'app.tenant.id': 'different' },
    { 'user.id': 'different' },
    { 'db.user': 'different' },
    { 'db.namespace': 'another' },
    { 'server.address': 'another' },
  ]) {
    const spans = [span(1, sqlKeyRead), span(2, { ...sqlKeyRead, ...change })];
    assert.deepEqual(cacheFindings(spans), []);
  }
  const spans = [
    span(1, redisKeyRead),
    span(2, redisKeyRead, { parentSpanId: 'f'.repeat(16) }),
    span(3, redisKeyRead, { traceId: 'f'.repeat(32) }),
  ];
  assert.deepEqual(cacheFindings(spans), []);
});

test('cache candidates retain arbitrary application context and require resolved targets and context values', () => {
  for (const key of ['workspaceId', 'app.organizationId', 'request.shardLabel', 'الجهة']) {
    const left = { ...sqlKeyRead, [key]: 'A' };
    assert.deepEqual(cacheFindings([span(1, left), span(2, { ...left, [key]: 'B' })]), []);
    assert.equal(cacheFindings([span(1, left), span(2, left)])[0]?.ruleId, 'duplicate-key-read');
  }
  for (const change of [
    { workspaceId: '[REDACTED]' },
    { workspaceId: '***' },
    { 'server.address': '[filtered]' },
    { 'db.connection_string': 'postgresql://app:****@host/store' },
    { 'db.namespace': 'unknown' },
    { 'db.namespace': '', 'db.redis.database_index': 3 },
  ]) {
    const hidden = { ...sqlKeyRead, ...change };
    assert.deepEqual(cacheFindings([span(1, hidden), span(2, hidden)]), []);
  }
  const complex = [span(1, sqlKeyRead), span(2, sqlKeyRead)];
  for (const item of complex) item.attributes.push({ key: 'app.scope', value: { kvlistValue: { values: [] } } });
  assert.deepEqual(cacheFindings(complex), []);
});

test('reused non-database layouts still check all values, span IDs, status and layout changes', () => {
  const first = span(1, { 'http.request.method': 'GET' });
  const next = span(2, { 'http.request.method': 'POST' });
  const bad = { ...next, attributes: [{ key: 'http.request.method', value: { stringValue: 3 } }] };
  for (const invalid of [
    bad,
    { ...next, spanId: '' },
    { ...next, traceId: null },
    { ...next, parentSpanId: false },
    { ...next, status: { code: 'ERROR' } },
  ]) {
    assert.throws(() => cacheFindings([first, invalid]), TypeError);
  }
  const keyed = [span(3, redisKeyRead), span(4, redisKeyRead)];
  assert.equal(cacheFindings([first, next, ...keyed])[0]?.ruleId, 'duplicate-key-read');
});

test('writes, transactions, missing evidence and errors suppress caching across the trace in any export order', () => {
  const reads = [span(1, redisKeyRead), span(2, redisKeyRead), span(3, sqlKeyRead), span(4, sqlKeyRead)];
  const others = [
    span(6, { ...redisKeyRead, 'db.query.text': 'SET private:customer:103 changed' }),
    span(6, { 'db.system': 'redis', 'db.operation': 'CUSTOM' }),
    span(6, { ...redisKeyRead, 'db.query.text': 'GET ?' }),
    span(6, { ...redisKeyRead, 'db.operation.name': 'MULTI' }),
    span(6, { ...redisKeyRead, 'db.transaction.id': 'private' }),
    span(6, { ...sqlKeyRead, 'db.query.text': 'UPDATE users SET value = $1' }, { parentSpanId: 'e'.repeat(16) }),
    span(6, { ...sqlKeyRead, 'db.query.text': 'BEGIN' }),
    span(6, redisKeyRead, { status: { code: 2 } }),
  ];
  for (const other of others) {
    for (const spans of [
      [other, ...reads],
      [...reads, other],
    ])
      assert.deepEqual(cacheFindings(spans), []);
  }
});

test('redacted Redis keys and incomplete, volatile or more complex SQL produce no caching advice', () => {
  const cases = ['?', '***', 'private:<redacted>', 'private:...', 'REDACTED'].map((key) => ({
    ...redisKeyRead,
    'db.query.text': `GET ${key}`,
  }));
  for (const query of [
    'SELECT current_timestamp FROM t WHERE id=$1',
    'SELECT random() FROM t WHERE id=$1',
    'SELECT id FROM t WHERE id=$1 AND active=$2',
    'SELECT id FROM t WHERE id=$1 FOR UPDATE',
    'SELECT id FROM t WHERE id=$1; COMMIT',
    'SELECT id FROM t WHERE id=1',
    'SELECT id FROM t WHERE id=$2',
  ]) {
    cases.push({ ...sqlKeyRead, 'db.query.text': query });
  }
  const { 'db.query.parameter.0': _omitted, ...withoutBind } = sqlKeyRead;
  cases.push(
    withoutBind,
    { ...sqlKeyRead, 'db.query.parameter.0': 'user:***' },
    { ...sqlKeyRead, 'db.query.parameter.1': 42 },
    { ...redisKeyRead, 'server.address': '' },
  );
  for (const read of cases) {
    assert.deepEqual(cacheFindings([span(1, read), span(2, read)]), []);
  }
  const hidden = Array.from({ length: 5 }, (_, index) =>
    span(index + 1, { ...redisKeyRead, 'db.query.text': 'GET ?' }),
  );
  assert.deepEqual(
    cacheFindings(hidden).map(({ ruleId }) => ruleId),
    ['redis-repeated-read'],
  );
});

test('single SQL binds match the driver placeholder and OTLP index or name', () => {
  const drivers = [
    ['mysql', '?', '0'],
    ['mariadb', '%s', '0'],
    ['postgresql', '%s', '0'],
    ['sqlite', '?', '0'],
    ['microsoft.sql_server', '@key', 'key'],
  ];
  for (const [system, placeholder, parameter] of drivers) {
    const read = {
      'db.system.name': system,
      'db.namespace': system === 'sqlite' ? '/data/shop.db' : 'shop',
      'server.address': 'localhost',
      'db.query.text': `SELECT state FROM orders WHERE id = ${placeholder}`,
      [`db.query.parameter.${parameter}`]: 900,
    };
    assert.deepEqual(
      cacheFindings([span(1, read), span(2, read)]).map(({ ruleId }) => ruleId),
      ['duplicate-key-read'],
    );
  }
});

const MILLISECOND_NANOSECONDS = 1e6;

function timed(index, startMs, endMs, values = postgres) {
  return span(index, values, {
    startTimeUnixNano: String(startMs * MILLISECOND_NANOSECONDS),
    endTimeUnixNano: String(endMs * MILLISECOND_NANOSECONDS),
  });
}

test('repeated-span impact is the union of overlapping and disjoint intervals against the slowest span', () => {
  const [finding] = analyzeTraces(
    {
      resourceSpans: [
        resource([timed(1, 0, 10), timed(2, 5, 12), timed(3, 20, 25), timed(4, 21, 22), timed(5, 30, 31)]),
      ],
    },
    { threshold: 5 },
  );
  assert.deepEqual(finding.impact, {
    kind: 'estimated',
    measured: ['before'],
    before: 12 + 5 + 1,
    after: 10,
    unit: 'ms',
    method: 'OTLP start/end times; after assumes one batched operation costs as much as the slowest span',
  });
});

test('groups with missing or invalid timestamps get no impact', () => {
  const spans = [1, 2, 3, 4].map((index) => timed(index, index, index + 1));
  for (const broken of [
    span(5, postgres),
    timed(5, 9, 8),
    span(5, postgres, { startTimeUnixNano: 'abc', endTimeUnixNano: '5' }),
  ]) {
    const [finding] = analyzeTraces({ resourceSpans: [resource([...spans, broken])] }, { threshold: 5 });
    assert.equal(finding.ruleId, 'repeated-db-span');
    assert.equal('impact' in finding, false);
  }
});

test('Redis repeated reads, namespace reads and duplicate key reads carry impact', () => {
  const reads = [1, 2, 3, 4, 5].map((index) => timed(index, 0, index, { ...mongo, 'db.collection.name': '' }));
  const findings = analyzeTraces({ resourceSpans: [resource(reads)] }, { threshold: 5 });
  assert.equal(findings[0].impact.before, 5);
  assert.equal(findings[0].impact.after, 5);
  const redis = [1, 2].map((index) => timed(index, 10 * index, 10 * index + 4, redisKeyRead));
  const duplicate = analyzeTraces({ resourceSpans: [resource(redis)] }, { threshold: 5 }).find(
    (finding) => finding.ruleId === 'duplicate-key-read',
  );
  assert.equal(duplicate.impact.before, 8);
  assert.equal(duplicate.impact.after, 4);
  const redisReads = [1, 2, 3, 4, 5].map((index) =>
    timed(index, 0, index, { ...redisKeyRead, 'db.query.text': `GET private:key:${index}` }),
  );
  const [redisFinding] = analyzeTraces({ resourceSpans: [resource(redisReads)] }, { threshold: 5 });
  assert.equal(redisFinding.ruleId, 'redis-repeated-read');
  assert.equal(redisFinding.impact.before, 5);
});

test('a large timed trace keeps one finding per group with correct impact', () => {
  const spans = Array.from({ length: 50000 }, (_, index) => timed(index + 1, index * 2, index * 2 + 1));
  const [finding] = analyzeTraces({ resourceSpans: [resource(spans)] }, { threshold: 5 });
  assert.equal(finding.count, 50000);
  assert.equal(finding.impact.before, 50000);
  assert.equal(finding.impact.after, 1);
});

test('traces text output prints the Impact line under a finding', () => {
  const { spawnSync } = require('node:child_process');
  const { mkdtempSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'traces-impact-')), 'trace.json');
  const spans = [1, 2, 3, 4, 5].map((index) => timed(index, 0, 10));
  writeFileSync(file, JSON.stringify({ resourceSpans: [resource(spans)] }));
  const result = spawnSync(
    process.execPath,
    [join(__dirname, '..', '..', 'bin', 'loadwise.cjs'), 'perf', 'traces', file],
    {
      encoding: 'utf8',
    },
  );
  assert.match(
    result.stdout,
    /\[repeated-db-span\][^\n]*\n {2}Impact: ~?10 ms measured -> ~?10 ms estimated; method: OTLP start\/end times/,
  );
});
