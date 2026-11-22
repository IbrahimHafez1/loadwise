'use strict';

// Every rule id with a registered fix builder is either verified by a case table or listed in NOT_YET_VERIFIED.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { requireWithSyntax } = require('../../lib/performance/compiler.cjs');
const { securityCases } = require('./fixtures/fix-verification/security-cases.cjs');
const { performanceCases } = require('./fixtures/fix-verification/performance-cases.cjs');
const { performanceQueryCases } = require('./fixtures/fix-verification/performance-query-cases.cjs');
const { performanceIntegrityCases } = require('./fixtures/fix-verification/performance-integrity-cases.cjs');
const { performanceFlowCases } = require('./fixtures/fix-verification/performance-flow-cases.cjs');
const { maintainabilityCases } = require('./fixtures/fix-verification/maintainability-cases.cjs');
const { notYetVerified: NOT_YET_VERIFIED } = require('./fixtures/fix-verification/not-yet-verified.cjs');

const libraryRoot = path.resolve(__dirname, '../../lib');
const builderModulePattern = /'(\.{1,2}\/[^']*site-fixes\/[^']+\.cjs)'/g;

// The builder modules a pillar's site-fix.cjs registers, read from its own list so this cannot drift from it.
function registeredRuleIds(siteFixFile, { needsSyntaxBinding }) {
  const siteFixPath = path.join(libraryRoot, siteFixFile);
  const source = fs.readFileSync(siteFixPath, 'utf8');
  const ruleIds = [];
  for (const [, relative] of source.matchAll(builderModulePattern)) {
    const modulePath = require.resolve(path.resolve(path.dirname(siteFixPath), relative));
    const builders = needsSyntaxBinding ? requireWithSyntax(modulePath, ts) : require(modulePath);
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
