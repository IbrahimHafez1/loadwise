// Plain data, so every command can validate --ignore against security ids without loading rule
// code. Each group lists its own ids in <group>/rule-ids.cjs; this file only merges them.
import injectionRules from './injection/rule-ids.js';
import requestForgeryRules from './request-forgery/rule-ids.js';
import authCryptoRules from './auth-crypto/rule-ids.js';
import exposureRules from './exposure/rule-ids.js';
import depsRules from './deps/rule-ids.js';
import filesRules from './files/rule-ids.js';
import type { ImpactLevel } from '../shared/types.js';

interface RuleInfo {
  group: string;
  needs: string;
}

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const movedRuleInfo: Record<string, RuleInfo> = {
  'drizzle-scope-unverified': { group: 'moved', needs: 'types' },
  'pg-dynamic-query-text': { group: 'moved', needs: 'types' },
  'prisma-scope-unverified': { group: 'moved', needs: 'types' },
};

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const phase5Rules: Record<string, { needs: string }> = {
  'express-cookie-auth-missing-csrf': { needs: 'syntax' },
  'graphql-batching-unbounded': { needs: 'syntax' },
  'jwt-weak-secret-literal': { needs: 'syntax' },
  'server-action-missing-auth': { needs: 'syntax' },
  'ssrf-redirect-bypass': { needs: 'syntax' },
  'vm-sandbox-escape': { needs: 'syntax' },
};

const groups: Record<string, Record<string, { needs: string }>> = {
  injection: injectionRules,
  'request-forgery': requestForgeryRules,
  'auth-crypto': authCryptoRules,
  exposure: exposureRules,
  deps: depsRules,
  files: filesRules,
  phase5: phase5Rules,
};

const ruleInfo: Record<string, RuleInfo> = { ...movedRuleInfo };
for (const [group, rules] of Object.entries(groups)) {
  for (const [ruleId, info] of Object.entries(rules)) {
    if (Object.hasOwn(ruleInfo, ruleId)) throw new Error('Duplicate security rule id: ' + ruleId);
    ruleInfo[ruleId] = { group, ...info };
  }
}

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const impactByRule: Readonly<Record<string, ImpactLevel>> = {
  'angular-bypass-security-trust': 'high',
  'auth-route-without-rate-limit': 'medium',
  'bcrypt-low-cost': 'medium',
  'client-env-secret-exposed': 'critical',
  'code-injection': 'critical',
  'command-injection': 'critical',
  'committed-secret': 'critical',
  'compose-hardcoded-secret': 'high',
  'cookie-missing-security-flags': 'high',
  'cors-credentials-any-origin': 'high',
  'cors-origin-regex-unanchored': 'medium',
  'csharp-ef-from-sql-raw': 'high',
  'csharp-process-start': 'medium',
  'database-error-in-response': 'medium',
  'dependency-known-vulnerability': 'medium',
  'dockerfile-add-remote-url': 'medium',
  'dockerfile-runs-as-root': 'medium',
  'dockerfile-secret-in-build': 'high',
  'dockerfile-unpinned-base-image': 'low',
  'dom-xss-sink': 'high',
  'drizzle-scope-unverified': 'high',
  'drizzle-sql-raw-dynamic': 'critical',
  'error-stack-in-response': 'medium',
  'express-cookie-auth-missing-csrf': 'high',
  'express-missing-helmet': 'low',
  'frontend-storage-secret-token': 'medium',
  'go-exec-command-shell': 'high',
  'go-sql-sprintf-injection': 'high',
  'graphql-batching-unbounded': 'medium',
  'graphql-introspection-enabled': 'medium',
  'graphql-query-depth-unbounded': 'medium',
  'hardcoded-secret': 'critical',
  'insecure-cipher': 'medium',
  'insecure-random-for-secret': 'high',
  'java-runtime-exec': 'medium',
  'java-sql-string-concat': 'high',
  'jsx-javascript-url': 'high',
  'jwt-decode-for-auth': 'high',
  'jwt-none-algorithm': 'critical',
  'jwt-sign-without-expiry': 'medium',
  'jwt-verify-without-algorithms': 'high',
  'jwt-weak-secret-literal': 'high',
  'knex-raw-dynamic-text': 'critical',
  'mass-assignment': 'high',
  'mysql-dynamic-query-text': 'critical',
  'nest-validation-without-whitelist': 'medium',
  'next-image-any-remote-host': 'medium',
  'nosql-operator-injection': 'high',
  'open-redirect': 'medium',
  'password-hash-in-response': 'high',
  'path-traversal': 'high',
  'pg-dynamic-query-text': 'medium',
  'plaintext-password-storage': 'critical',
  'postmessage-missing-origin-check': 'medium',
  'prisma-raw-unsafe-dynamic': 'critical',
  'prisma-scope-unverified': 'high',
  'prototype-pollution': 'high',
  'python-insecure-deserialization': 'high',
  'python-subprocess-shell-true': 'high',
  'python-unsafe-yaml-load': 'high',
  'react-dangerously-set-inner-html': 'high',
  'reflected-xss-response': 'low',
  'regex-catastrophic-backtracking': 'high',
  'regex-from-input': 'medium',
  'rust-command-shell': 'high',
  'rust-unsafe-raw-pointer-deref': 'medium',
  'secret-compared-non-constant-time': 'medium',
  'secret-in-log': 'high',
  'secret-in-url-query': 'medium',
  'sequelize-dynamic-query-text': 'critical',
  'server-action-missing-auth': 'high',
  'ssrf-redirect-bypass': 'high',
  'ssrf-request-url': 'high',
  'storage-object-public-acl': 'high',
  'template-autoescape-disabled': 'medium',
  'template-injection': 'critical',
  'tls-verification-disabled': 'high',
  'typeorm-dynamic-query-text': 'critical',
  'upload-client-filename': 'medium',
  'vm-sandbox-escape': 'critical',
  'vue-v-html-unsanitized': 'high',
  'weak-password-hash': 'high',
  'xml-external-entities': 'medium',
  'zip-slip-extraction': 'high',
};

// Rules the ast-grep polyglot scan reports from polyglot/security. They are syntactic patterns, so
// they are not in ruleInfo, which lists only the TypeScript source rules that --ignore accepts.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const polyglotRules = [
  'csharp-ef-from-sql-raw',
  'csharp-process-start',
  'go-exec-command-shell',
  'go-sql-sprintf-injection',
  'java-runtime-exec',
  'java-sql-string-concat',
  'python-insecure-deserialization',
  'python-subprocess-shell-true',
  'python-unsafe-yaml-load',
  'rust-command-shell',
  'rust-unsafe-raw-pointer-deref',
];

const securityRules = Object.keys(ruleInfo);
// Findings of these rules count for `--fail-on contract`. None yet; see the security design, open
// question 1.
const contractRules = new Set<string>();

export const movedRules = Object.keys(movedRuleInfo);
export { securityRules, polyglotRules, ruleInfo, impactByRule, contractRules };
