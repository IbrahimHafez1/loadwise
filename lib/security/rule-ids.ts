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

const movedRuleInfo: Record<string, RuleInfo> = {
  'pg-dynamic-query-text': { group: 'moved', needs: 'types' },
  'prisma-scope-unverified': { group: 'moved', needs: 'types' },
  'drizzle-scope-unverified': { group: 'moved', needs: 'types' },
};

const phase5Rules: Record<string, { needs: string }> = {
  'server-action-missing-auth': { needs: 'syntax' },
  'ssrf-redirect-bypass': { needs: 'syntax' },
  'vm-sandbox-escape': { needs: 'syntax' },
  'jwt-weak-secret-literal': { needs: 'syntax' },
  'graphql-batching-unbounded': { needs: 'syntax' },
  'express-cookie-auth-missing-csrf': { needs: 'syntax' },
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

const impactByRule: Readonly<Record<string, ImpactLevel>> = {
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
  'regex-catastrophic-backtracking': 'high',
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
  'plaintext-password-storage': 'critical',
  'cookie-missing-security-flags': 'high',
  'cors-credentials-any-origin': 'high',
  'cors-origin-regex-unanchored': 'medium',
  'error-stack-in-response': 'medium',
  'graphql-introspection-enabled': 'medium',
  'mass-assignment': 'high',
  'nest-validation-without-whitelist': 'medium',
  'prototype-pollution': 'high',
  'reflected-xss-response': 'low',
  'secret-in-log': 'high',
  'template-autoescape-disabled': 'medium',
  'xml-external-entities': 'medium',
  'password-hash-in-response': 'high',
  'storage-object-public-acl': 'high',
  'secret-in-url-query': 'medium',
  'auth-route-without-rate-limit': 'medium',
  'graphql-query-depth-unbounded': 'medium',
  'database-error-in-response': 'medium',
  'dom-xss-sink': 'high',
  'react-dangerously-set-inner-html': 'high',
  'angular-bypass-security-trust': 'high',
  'vue-v-html-unsanitized': 'high',
  'frontend-storage-secret-token': 'medium',
  'postmessage-missing-origin-check': 'medium',
  'client-env-secret-exposed': 'critical',
  'jsx-javascript-url': 'high',
  'next-image-any-remote-host': 'medium',
  'express-missing-helmet': 'low',
  'dependency-known-vulnerability': 'medium',
  'committed-secret': 'critical',
  'compose-hardcoded-secret': 'high',
  'dockerfile-add-remote-url': 'medium',
  'dockerfile-runs-as-root': 'medium',
  'dockerfile-secret-in-build': 'high',
  'dockerfile-unpinned-base-image': 'low',
  'server-action-missing-auth': 'high',
  'ssrf-redirect-bypass': 'high',
  'vm-sandbox-escape': 'critical',
  'jwt-weak-secret-literal': 'high',
  'graphql-batching-unbounded': 'medium',
  'express-cookie-auth-missing-csrf': 'high',
  'csharp-process-start': 'medium',
  'csharp-ef-from-sql-raw': 'high',
  'go-exec-command-shell': 'high',
  'go-sql-sprintf-injection': 'high',
  'java-runtime-exec': 'medium',
  'java-sql-string-concat': 'high',
  'python-insecure-deserialization': 'high',
  'python-unsafe-yaml-load': 'high',
  'python-subprocess-shell-true': 'high',
  'rust-command-shell': 'high',
  'rust-unsafe-raw-pointer-deref': 'medium',
};

// Rules the ast-grep polyglot scan reports from polyglot/security. They are syntactic patterns, so
// they are not in ruleInfo, which lists only the TypeScript source rules that --ignore accepts.
const polyglotRules = [
  'csharp-process-start',
  'csharp-ef-from-sql-raw',
  'go-exec-command-shell',
  'go-sql-sprintf-injection',
  'java-runtime-exec',
  'java-sql-string-concat',
  'python-insecure-deserialization',
  'python-unsafe-yaml-load',
  'python-subprocess-shell-true',
  'rust-command-shell',
  'rust-unsafe-raw-pointer-deref',
];

const securityRules = Object.keys(ruleInfo);
// Findings of these rules count for `--fail-on contract`. None yet; see the security design, open
// question 1.
const contractRules = new Set<string>();

export const movedRules = Object.keys(movedRuleInfo);
export { securityRules, polyglotRules, ruleInfo, impactByRule, contractRules };
