import test from 'node:test';
import { verifyFix } from './fix-verification.js';
import { accessibilityCases } from './fixtures/fix-verification/accessibility-cases.js';

for (const { ruleId, files, policy, todo } of accessibilityCases) {
  test(`the ${ruleId} fix compiles and removes its finding`, { todo }, () =>
    verifyFix({ pillar: 'accessibility', ruleId, files, policy }),
  );
}
