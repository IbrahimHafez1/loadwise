'use strict';

const test = require('node:test');
const { verifyFix } = require('./fix-verification.cjs');
const { securityCases } = require('./fixtures/fix-verification/security-cases.cjs');

for (const { ruleId, files, policy, todo } of securityCases) {
  test(`the ${ruleId} fix compiles and removes its finding`, { todo }, () =>
    verifyFix({ pillar: 'security', ruleId, files, policy }),
  );
}
