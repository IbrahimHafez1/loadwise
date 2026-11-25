import test from 'node:test';
import { verifyFix } from './fix-verification.js';
import { performanceCases } from './fixtures/fix-verification/performance-cases.js';
import { performanceQueryCases } from './fixtures/fix-verification/performance-query-cases.js';
import { performanceIntegrityCases } from './fixtures/fix-verification/performance-integrity-cases.js';
import { performanceFlowCases } from './fixtures/fix-verification/performance-flow-cases.js';
import { performanceAddedCases } from './fixtures/fix-verification/performance-added-cases.js';
import { performanceOrmCases } from './fixtures/fix-verification/performance-orm-cases.js';
import { performanceHandlerCases } from './fixtures/fix-verification/performance-handler-cases.js';
import { performanceSchemaCases } from './fixtures/fix-verification/performance-schema-cases.js';
import type { FixVerificationCase } from '../types/fix-verification.js';

const allPerformanceCases: FixVerificationCase[] = [
  ...performanceCases,
  ...performanceQueryCases,
  ...performanceIntegrityCases,
  ...performanceFlowCases,
  ...performanceAddedCases,
  ...performanceOrmCases,
  ...performanceHandlerCases,
  ...performanceSchemaCases,
];

for (const { ruleId, files, policy, migrations, todo } of allPerformanceCases) {
  test(`the ${ruleId} fix compiles and removes its finding`, { todo }, () =>
    verifyFix({ pillar: 'performance', ruleId, files, policy, migrations }),
  );
}
