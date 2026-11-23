'use strict';

const test = require('node:test');
const { verifyFix } = require('./fix-verification.cjs');
const { performanceCases } = require('./fixtures/fix-verification/performance-cases.cjs');
const { performanceQueryCases } = require('./fixtures/fix-verification/performance-query-cases.cjs');
const { performanceIntegrityCases } = require('./fixtures/fix-verification/performance-integrity-cases.cjs');
const { performanceFlowCases } = require('./fixtures/fix-verification/performance-flow-cases.cjs');
const { performanceAddedCases } = require('./fixtures/fix-verification/performance-added-cases.cjs');
const { performanceOrmCases } = require('./fixtures/fix-verification/performance-orm-cases.cjs');
const { performanceHandlerCases } = require('./fixtures/fix-verification/performance-handler-cases.cjs');
const { performanceSchemaCases } = require('./fixtures/fix-verification/performance-schema-cases.cjs');

for (const { ruleId, files, policy, migrations, todo } of [
  ...performanceCases,
  ...performanceQueryCases,
  ...performanceIntegrityCases,
  ...performanceFlowCases,
  ...performanceAddedCases,
  ...performanceOrmCases,
  ...performanceHandlerCases,
  ...performanceSchemaCases,
]) {
  test(`the ${ruleId} fix compiles and removes its finding`, { todo }, () =>
    verifyFix({ pillar: 'performance', ruleId, files, policy, migrations }),
  );
}
