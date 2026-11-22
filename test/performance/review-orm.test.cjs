'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const { withProgram } = require('./helpers.cjs');
const { checkRedisCall } = require('../../lib/performance/redis.cjs');
const { isRepeated } = require('../../lib/performance/repeated.cjs');

const CALLS_IN_LOOP = 4000;
// Quadratic rescans of the loop body took over 10 s for this input; linear takes well under 1 s.
const TIME_BUDGET_MS = 4000;

test('many get calls in one loop do not rescan the loop body for each call', () => {
  const calls = Array.from({ length: CALLS_IN_LOOP }, (_, index) => `  cache.get(ids[${index}]);`).join('\n');
  const source = `const cache = new Map<string, string>();\nfunction run(ids: string[]) { for (const id of ids) {\n${calls}\n} }`;
  withProgram(source, {}, (program, sourceFile) => {
    const checker = program.getTypeChecker();
    const context = { checker, isRepeated: (node) => isRepeated(node, checker), report() {} };
    const start = performance.now();
    (function visit(node) {
      if (ts.isCallExpression(node)) checkRedisCall(node, context);
      ts.forEachChild(node, visit);
    })(sourceFile);
    assert.ok(performance.now() - start < TIME_BUDGET_MS);
  });
});

const { checkPostgresCall } = require('../../lib/performance/postgres.cjs');

const PG_QUERIES_IN_LOOP = 3000;
// Rescanning the loop body for each query took over 30 s for this input; one scan per loop takes under 3 s.
const PG_TIME_BUDGET_MS = 6000;

test('many pg queries in one loop do not rescan the loop body for each query', () => {
  const pgTypes = `interface PgResult { rows: { id: number }[] }
export class Pool { query(input: string, values?: unknown[]): Promise<PgResult>; }`;
  const queries = Array.from(
    { length: PG_QUERIES_IN_LOOP },
    (_, index) => `  await pool.query(sql${index % 10}, [id]);`,
  ).join('\n');
  const source = `import { Pool } from 'pg';\nconst pool = new Pool();\ndeclare const sql0: string, sql1: string, sql2: string, sql3: string, sql4: string, sql5: string, sql6: string, sql7: string, sql8: string, sql9: string;\nasync function run(ids: number[]) { for (const id of ids) {\n${queries}\n} }`;
  withProgram(source, { 'node_modules/@types/pg/index.d.ts': pgTypes }, (program, sourceFile) => {
    const checker = program.getTypeChecker();
    let reported = 0;
    const context = {
      checker,
      isRepeated: (node) => isRepeated(node, checker),
      isPackageType: () => true,
      report() {
        reported++;
      },
    };
    const start = performance.now();
    (function visit(node) {
      if (ts.isCallExpression(node)) checkPostgresCall(node, context);
      ts.forEachChild(node, visit);
    })(sourceFile);
    assert.ok(performance.now() - start < PG_TIME_BUDGET_MS);
    assert.equal(reported, PG_QUERIES_IN_LOOP);
  });
});
