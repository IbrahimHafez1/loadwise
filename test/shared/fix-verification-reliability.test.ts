import test from 'node:test';
import { verifyFix } from './fix-verification.js';
import { reliabilityCases } from './fixtures/fix-verification/reliability-cases.js';

for (const { ruleId, files, policy, todo } of reliabilityCases) {
  test(`the ${ruleId} fix compiles and removes its finding`, { todo }, () =>
    verifyFix({ pillar: 'reliability', ruleId, files, policy }),
  );
}
