import test from 'node:test';
import { verifyFix } from './fix-verification.cjs';
import { maintainabilityCases } from './fixtures/fix-verification/maintainability-cases.cjs';

for (const { ruleId, files, policy, todo } of maintainabilityCases) {
  test(`the ${ruleId} fix compiles and removes its finding`, { todo }, () =>
    verifyFix({ pillar: 'maintainability', ruleId, files, policy }),
  );
}
