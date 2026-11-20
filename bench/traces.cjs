'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { resolve } = require('node:path');
const { inspectTraces } = require('../lib/performance/traces.cjs');

const REQUESTS = 240;
const SPANS_PER_REQUEST = 100;
const DATABASE_SPANS = 20;
const WARMUP_ROUNDS = 3;
const SAMPLE_ROUNDS = 12;

function attribute(key, value) {
  return { key, value: { stringValue: value } };
}

function buildExport(withBindings) {
  const postgres = [
    attribute('db.system.name', 'postgresql'),
    attribute('db.namespace', 'shop'),
    attribute('db.query.text', 'SELECT state FROM orders WHERE id = $1'),
    attribute('server.address', 'db'),
  ];
  const mongo = [
    attribute('db.system.name', 'mongodb'),
    attribute('db.namespace', 'store'),
    attribute('db.operation.name', 'find'),
    attribute('db.collection.name', 'orders'),
  ];
  const nonDatabase = [
    attribute('http.request.method', 'GET'),
    attribute('url.scheme', 'https'),
    attribute('server.address', 'api.local'),
    attribute('http.route', '/orders/:id'),
  ];
  const spans = [];
  for (let request = 1; request <= REQUESTS; request++) {
    const traceId = '91a8e606a32944b9' + request.toString(16).padStart(16, '0');
    for (let index = 1; index <= SPANS_PER_REQUEST; index++) {
      const isDatabase = index <= DATABASE_SPANS;
      const fields = isDatabase ? (index % 2 ? postgres : mongo) : nonDatabase;
      const bound =
        withBindings && fields === postgres
          ? [{ key: 'db.query.parameter.0', value: { intValue: index < DATABASE_SPANS / 2 ? 1 : index } }]
          : [];
      spans.push({
        traceId,
        spanId: '1' + index.toString(16).padStart(15, '0'),
        parentSpanId: '7c5fed18d05db4a3',
        kind: isDatabase || index % 4 === 0 ? 3 : 1,
        name: isDatabase ? 'db' : 'process',
        attributes: [
          ...fields,
          ...bound,
          attribute('request.index', String(request)),
          { key: 'sampled', value: { boolValue: true } },
        ],
      });
    }
  }
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
}

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
}

function benchmark(label, variants, getDocument, expected) {
  const samples = variants.map(() => []);
  for (let round = 0; round < WARMUP_ROUNDS + SAMPLE_ROUNDS; round++) {
    const order = variants.map((_, index) => index);
    if (round % 2) order.reverse();
    for (const index of order) {
      const start = performance.now();
      const result = variants[index].inspect(getDocument());
      const duration = performance.now() - start;
      assert.deepStrictEqual(result, expected);
      if (round >= WARMUP_ROUNDS) samples[index].push(duration);
    }
  }
  for (let index = 0; index < variants.length; index++) {
    console.log(`${label}, ${variants[index].name}: median ${median(samples[index]).toFixed(1)} ms`);
  }
}

const variants = [{ name: 'current', inspect: inspectTraces }];
const args = process.argv.slice(2);
const withBindings = args.includes('--cache-lookups');
const [baselineFlag, baselinePath, ...extra] = args.filter((arg) => arg !== '--cache-lookups');
if (baselineFlag !== undefined) {
  if (baselineFlag !== '--baseline' || !baselinePath || extra.length)
    throw new Error('Expected --baseline path/to/traces.cjs');
  variants.unshift({ name: 'baseline', inspect: require(resolve(baselinePath)).inspectTraces });
}
const json = buildExport(withBindings);
const document = JSON.parse(json);
const expected = inspectTraces(document);
assert.equal(expected.scannedSpans, REQUESTS * SPANS_PER_REQUEST);
assert.equal(expected.eligibleDbSpans, REQUESTS * DATABASE_SPANS);
assert.equal(expected.findings.length, REQUESTS * (withBindings ? 3 : 2));
console.log(
  `Node ${process.version}, ${expected.scannedSpans} spans, ${expected.eligibleDbSpans} eligible, ${expected.findings.length} findings, ${(Buffer.byteLength(json) / 1024 ** 2).toFixed(1)} MiB JSON.`,
);
console.log(
  `${WARMUP_ROUNDS} warm-up rounds and ${SAMPLE_ROUNDS} measured rounds per variant; full result equality checked each time.`,
);
benchmark('Scan', variants, () => document, expected);
benchmark('JSON parse and scan', variants, () => JSON.parse(json), expected);
