import test from 'node:test';
import { verifyFix } from './fix-verification.js';
import { securityCases } from './fixtures/fix-verification/security-cases.js';

for (const { ruleId, files, policy, todo } of securityCases) {
  test(`the ${ruleId} fix compiles and removes its finding`, { todo }, () =>
    verifyFix({ pillar: 'security', ruleId, files, policy }),
  );
}
