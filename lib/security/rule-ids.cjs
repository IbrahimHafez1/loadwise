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
  deps: require('./deps/rule-ids.cjs'),
  files: require('./files/rule-ids.cjs'),
};

const ruleInfo = { ...movedRules };
for (const [group, rules] of Object.entries(groups)) {
  for (const [ruleId, info] of Object.entries(rules)) {
    if (Object.hasOwn(ruleInfo, ruleId)) throw new Error('Duplicate security rule id: ' + ruleId);
    ruleInfo[ruleId] = { group, ...info };
  }
}

const impactByRule = {
  'pg-dynamic-query-text': 'medium',
  'prisma-scope-unverified': 'high',
  'drizzle-scope-unverified': 'high',
  'code-injection': 'critical',
  'command-injection': 'critical',
  'drizzle-sql-raw-dynamic': 'critical',
  'knex-raw-dynamic-text': 'critical',
  'mysql-dynamic-query-text': 'critical',
  'nosql-operator-injection': 'high',
  'prisma-raw-unsafe-dynamic': 'critical',
  'regex-from-input': 'medium',
  'sequelize-dynamic-query-text': 'critical',
  'template-injection': 'critical',
  'typeorm-dynamic-query-text': 'critical',
  'open-redirect': 'medium',
  'path-traversal': 'high',
  'ssrf-request-url': 'high',
  'upload-client-filename': 'medium',
  'zip-slip-extraction': 'high',
  'bcrypt-low-cost': 'medium',
  'hardcoded-secret': 'critical',
  'insecure-cipher': 'medium',
  'insecure-random-for-secret': 'high',
  'jwt-decode-for-auth': 'high',
  'jwt-none-algorithm': 'critical',
  'jwt-sign-without-expiry': 'medium',
  'jwt-verify-without-algorithms': 'high',
  'secret-compared-non-constant-time': 'medium',
  'tls-verification-disabled': 'high',
  'weak-password-hash': 'high',
  'cookie-missing-security-flags': 'high',
  'cors-credentials-any-origin': 'high',
  'error-stack-in-response': 'medium',
  'graphql-introspection-enabled': 'medium',
  'mass-assignment': 'high',
  'nest-validation-without-whitelist': 'medium',
  'prototype-pollution': 'high',
  'reflected-xss-response': 'low',
  'secret-in-log': 'high',
  'xml-external-entities': 'medium',
  'dependency-known-vulnerability': 'medium',
  'committed-secret': 'critical',
  'compose-hardcoded-secret': 'high',
  'dockerfile-add-remote-url': 'medium',
  'dockerfile-runs-as-root': 'medium',
  'dockerfile-secret-in-build': 'high',
  'dockerfile-unpinned-base-image': 'low',
};

const securityRules = Object.keys(ruleInfo);
// Findings of these rules count for `--fail-on contract`. None yet; see the security design, open question 1.
const contractRules = new Set();

module.exports = { securityRules, ruleInfo, impactByRule, contractRules, movedRules: Object.keys(movedRules) };
