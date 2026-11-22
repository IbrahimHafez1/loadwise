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
