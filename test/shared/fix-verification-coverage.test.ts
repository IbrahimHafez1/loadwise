// Every rule id with a registered fix builder is either verified by a case table or listed in
// NOT_YET_VERIFIED.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { securityCases } from './fixtures/fix-verification/security-cases.js';
import { performanceCases } from './fixtures/fix-verification/performance-cases.js';
import { performanceQueryCases } from './fixtures/fix-verification/performance-query-cases.js';
import { performanceIntegrityCases } from './fixtures/fix-verification/performance-integrity-cases.js';
import { performanceFlowCases } from './fixtures/fix-verification/performance-flow-cases.js';
import { performanceAddedCases } from './fixtures/fix-verification/performance-added-cases.js';
import { performanceOrmCases } from './fixtures/fix-verification/performance-orm-cases.js';
import { performanceHandlerCases } from './fixtures/fix-verification/performance-handler-cases.js';
import { performanceSchemaCases } from './fixtures/fix-verification/performance-schema-cases.js';
import { reliabilityCases } from './fixtures/fix-verification/reliability-cases.js';
import { accessibilityCases } from './fixtures/fix-verification/accessibility-cases.js';
import { maintainabilityCases } from './fixtures/fix-verification/maintainability-cases.js';
import { notYetVerified as NOT_YET_VERIFIED } from './fixtures/fix-verification/not-yet-verified.js';

const libraryRoot = path.resolve(import.meta.dirname, '../../lib');
const builderModulePattern = /'(\.{1,2}\/[^']*site-fixes\/[^']+\.js)'/g;

// The builder modules a pillar's site-fix.js registers, read from its own list so this cannot
// drift from it.
async function registeredRuleIds(siteFixFile: string) {
  const siteFixPath = path.join(libraryRoot, siteFixFile);
  const source = fs.readFileSync(siteFixPath, 'utf8');
  const ruleIds: string[] = [];
  for (const [, relative] of source.matchAll(builderModulePattern)) {
    const modulePath = path.resolve(path.dirname(siteFixPath), relative);
    const loaded: { default: Record<string, unknown> } = await import(pathToFileURL(modulePath).href);
    ruleIds.push(...Object.keys(loaded.default));
  }
  return [...new Set(ruleIds)];
}

const registered = [
  ...(await registeredRuleIds('performance/site-fix.js')),
  ...(await registeredRuleIds('maintainability/site-fix.js')),
];
const verified = new Set(
  [
    ...securityCases,
    ...performanceCases,
    ...performanceQueryCases,
    ...performanceIntegrityCases,
    ...performanceFlowCases,
    ...performanceAddedCases,
    ...performanceOrmCases,
    ...performanceHandlerCases,
    ...performanceSchemaCases,
    ...reliabilityCases,
    ...accessibilityCases,
    ...maintainabilityCases,
  ].map(({ ruleId }) => ruleId),
);

test('every rule id with a fix builder is verified or listed in NOT_YET_VERIFIED', () => {
  const unaccounted = registered.filter((ruleId) => !verified.has(ruleId) && !(ruleId in NOT_YET_VERIFIED));
  assert.deepEqual(unaccounted, [], 'add a verification sample, or list the rule id in not-yet-verified.cjs');
});

test('NOT_YET_VERIFIED lists only registered builders that no sample covers, each with a reason', () => {
  for (const [ruleId, reason] of Object.entries(NOT_YET_VERIFIED)) {
    assert.ok(registered.includes(ruleId), `${ruleId} has no registered fix builder any more`);
    assert.ok(!verified.has(ruleId), `${ruleId} is verified now; remove it from NOT_YET_VERIFIED`);
    assert.ok(reason.length > 0, `${ruleId} needs a reason`);
  }
});

test('every verification sample names a rule with a registered fix builder', () => {
  for (const ruleId of verified) assert.ok(registered.includes(ruleId), `${ruleId} has no registered fix builder`);
});
