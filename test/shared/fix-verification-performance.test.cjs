'use strict';

const test = require('node:test');
const { verifyFix } = require('./fix-verification.cjs');
const { performanceCases } = require('./fixtures/fix-verification/performance-cases.cjs');
const { performanceQueryCases } = require('./fixtures/fix-verification/performance-query-cases.cjs');
const { performanceIntegrityCases } = require('./fixtures/fix-verification/performance-integrity-cases.cjs');
const { performanceFlowCases } = require('./fixtures/fix-verification/performance-flow-cases.cjs');

for (const { ruleId, files, policy, todo } of [
  ...performanceCases,
  ...performanceQueryCases,
  ...performanceIntegrityCases,
  ...performanceFlowCases,
]) {
  test(`the ${ruleId} fix compiles and removes its finding`, { todo }, () =>
    verifyFix({ pillar: 'performance', ruleId, files, policy }),
  );
}
