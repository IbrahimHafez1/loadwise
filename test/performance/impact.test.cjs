'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { loopImpact, formatImpact, isLoopRule } = require('../../lib/performance/impact.cjs');
const { useSnapshot } = require('../../lib/performance/schema/context.cjs');

const pgFiles = {
  'node_modules/@types/pg/index.d.ts': `
    interface PgResult { rows: { id: number }[] }
    export class Pool { query(text: string, values?: unknown[]): Promise<PgResult>; }
  `,
};
const loopSource = `import type { Pool } from 'pg';
  export async function load(pool: Pool, ids: number[]) {
    for (const id of ids) await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  }`;
const snapshot = {
  version: 1,
  dialect: 'postgres',
  capturedAt: '2026-11-18T10:00:00Z',
  roundTrip: { medianMs: 1.8, runs: 20, kind: 'measured', measuredFrom: 'cli-host' },
  tables: {},
};

test('without a snapshot a loop finding counts round trips and never prints milliseconds', () => {
  const impact = loopImpact(undefined);
  assert.deepEqual(impact, {
    kind: 'estimated',
    before: 'N',
    after: 1,
    unit: 'round trips',
    method: 'query count model',
  });
  const text = formatImpact(impact);
  assert.equal(text, 'Impact: N round trips estimated -> ~1 round trip estimated; method: query count model.');
  assert.doesNotMatch(text, /\bms\b|\d s\b/);
});

test('a snapshot round trip yields an estimate anchored on the measured side', () => {
  const impact = loopImpact(snapshot);
  assert.equal(impact.kind, 'estimated');
  assert.deepEqual(impact.measured, ['after']);
  assert.equal(impact.before, 1800);
  assert.equal(impact.after, 1.8);
  assert.match(impact.method, /median of 20 SELECT 1 from the CLI host on 2026-11-18/);
  assert.match(
    formatImpact(impact),
    /^Impact: ~1\.8 s estimated -> 1\.8 ms measured; method: round trip measured .* excludes query execution\.$/,
  );
  assert.match(loopImpact({ ...snapshot, dialect: 'mongo' }).method, /median of 20 ping/);
});

test('every printed number carries a label and unmeasured milliseconds are withheld', () => {
  assert.equal(
    formatImpact({ kind: 'estimated', before: 900, after: 30, unit: 'ms', method: 'guess' }),
    undefined,
    'I7: no millisecond value without a measurement',
  );
  assert.equal(
    formatImpact({
      kind: 'estimated',
      measured: ['before'],
      before: 412,
      after: 11,
      unit: 'ms',
      method: 'OTLP span durations',
    }),
    'Impact: 412 ms measured -> ~11 ms estimated; method: OTLP span durations.',
  );
  assert.equal(
    formatImpact({ kind: 'estimated', before: 1520.4, after: 8, unit: 'planner cost', method: 'HypoPG' }),
    'Impact: ~1,520 planner cost estimated -> ~8 planner cost estimated; method: HypoPG.',
  );
  assert.equal(
    formatImpact({ kind: 'measured', before: 2400, after: 3.25, unit: 'ms', method: 'median of 5 runs.' }),
    'Impact: 2.4 s measured -> 3.3 ms measured; method: median of 5 runs.',
  );
  assert.equal(formatImpact(undefined), undefined);
});

test('only query-in-loop rules receive loop impact', () => {
  assert.ok(isLoopRule('pg-query-in-loop'));
  assert.ok(isLoopRule('orm-query-in-loop'));
  assert.ok(!isLoopRule('typeorm-transaction-in-loop'));
  assert.ok(!isLoopRule('pg-count-materialization'));
});

test('analyzeFile attaches impact to loop findings, refined by the active snapshot', (context) => {
  context.after(() => useSnapshot(undefined));
  const [plain] = lint(loopSource, pgFiles).filter(({ ruleId }) => ruleId === 'pg-query-in-loop');
  assert.equal(plain.impact.unit, 'round trips');
  useSnapshot(snapshot);
  const [measured] = lint(loopSource, pgFiles).filter(({ ruleId }) => ruleId === 'pg-query-in-loop');
  assert.equal(measured.impact.unit, 'ms');
  assert.equal(measured.impact.after, 1.8);
});
