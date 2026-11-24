import test from 'node:test';
import { verifyFix } from './fix-verification.cjs';
import { performanceCases } from './fixtures/fix-verification/performance-cases.cjs';
import { performanceQueryCases } from './fixtures/fix-verification/performance-query-cases.cjs';
import { performanceIntegrityCases } from './fixtures/fix-verification/performance-integrity-cases.cjs';
import { performanceFlowCases } from './fixtures/fix-verification/performance-flow-cases.cjs';
import { performanceAddedCases } from './fixtures/fix-verification/performance-added-cases.cjs';
import { performanceOrmCases } from './fixtures/fix-verification/performance-orm-cases.cjs';
import { performanceHandlerCases } from './fixtures/fix-verification/performance-handler-cases.cjs';
import { performanceSchemaCases } from './fixtures/fix-verification/performance-schema-cases.cjs';
import type { FixVerificationCase } from '../types/fix-verification.cjs';

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
