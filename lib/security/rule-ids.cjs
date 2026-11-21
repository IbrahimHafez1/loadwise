'use strict';

// Plain data, so every command can validate --ignore against security ids without loading rule code.
// Each group lists its own ids in <group>/rule-ids.cjs; this file only merges them.
const movedRules = {
  'pg-dynamic-query-text': { group: 'moved', needs: 'types' },
  'prisma-scope-unverified': { group: 'moved', needs: 'types' },
  'drizzle-scope-unverified': { group: 'moved', needs: 'types' },
};

const groups = {
  injection: require('./injection/rule-ids.cjs'),
  'request-forgery': require('./request-forgery/rule-ids.cjs'),
  'auth-crypto': require('./auth-crypto/rule-ids.cjs'),
  exposure: require('./exposure/rule-ids.cjs'),
};

const ruleInfo = { ...movedRules };
for (const [group, rules] of Object.entries(groups)) {
  for (const [ruleId, info] of Object.entries(rules)) {
    if (Object.hasOwn(ruleInfo, ruleId)) throw new Error('Duplicate security rule id: ' + ruleId);
    ruleInfo[ruleId] = { group, ...info };
  }
}

const securityRules = Object.keys(ruleInfo);
// Findings of these rules count for `--fail-on contract`. None yet; see the security design, open question 1.
const contractRules = new Set();

module.exports = { securityRules, ruleInfo, contractRules, movedRules: Object.keys(movedRules) };
