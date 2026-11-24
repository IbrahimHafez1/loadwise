// Every rule id with a registered fix builder is either verified by a case table or listed in
// NOT_YET_VERIFIED.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { requireWithSyntax } from '../../lib/performance/compiler.cjs';
import { securityCases } from './fixtures/fix-verification/security-cases.cjs';
import { performanceCases } from './fixtures/fix-verification/performance-cases.cjs';
import { performanceQueryCases } from './fixtures/fix-verification/performance-query-cases.cjs';
import { performanceIntegrityCases } from './fixtures/fix-verification/performance-integrity-cases.cjs';
import { performanceFlowCases } from './fixtures/fix-verification/performance-flow-cases.cjs';
import { performanceAddedCases } from './fixtures/fix-verification/performance-added-cases.cjs';
import { performanceOrmCases } from './fixtures/fix-verification/performance-orm-cases.cjs';
import { performanceHandlerCases } from './fixtures/fix-verification/performance-handler-cases.cjs';
import { performanceSchemaCases } from './fixtures/fix-verification/performance-schema-cases.cjs';
import { maintainabilityCases } from './fixtures/fix-verification/maintainability-cases.cjs';
import { notYetVerified as NOT_YET_VERIFIED } from './fixtures/fix-verification/not-yet-verified.cjs';

const libraryRoot = path.resolve(__dirname, '../../lib');
const builderModulePattern = /'(\.{1,2}\/[^']*site-fixes\/[^']+\.cjs)'/g;

// The builder modules a pillar's site-fix.cjs registers, read from its own list so this cannot
// drift from it.
function registeredRuleIds(siteFixFile: string, { needsSyntaxBinding }: { needsSyntaxBinding: boolean }) {
  const siteFixPath = path.join(libraryRoot, siteFixFile);
  const source = fs.readFileSync(siteFixPath, 'utf8');
  const ruleIds: string[] = [];
  for (const [, relative] of source.matchAll(builderModulePattern)) {
    const modulePath = require.resolve(path.resolve(path.dirname(siteFixPath), relative));
    const builders = needsSyntaxBinding ? requireWithSyntax(modulePath, ts).default : require(modulePath).default;
    ruleIds.push(...Object.keys(builders));
  }
  return [...new Set(ruleIds)];
}

const registered = [
  ...registeredRuleIds('performance/site-fix.cjs', { needsSyntaxBinding: true }),
  ...registeredRuleIds('maintainability/site-fix.cjs', { needsSyntaxBinding: false }),
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
