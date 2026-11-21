'use strict';

const { findingLevel, repositoryPath } = require('./finding-location.cjs');

const sarifSchema = 'https://json.schemastore.org/sarif-2.1.0.json';
const documentationUrl = 'https://github.com/IbrahimHafez1/loadwise';
const fingerprintKey = 'loadwise/findingId/v1';

const descriptionsByPillar = {
  performance: () => require('../../performance/rule-ids.cjs').descriptionByRule,
  maintainability: () => require('../../maintainability/rule-ids.cjs').descriptionByRule,
  security: () => require('../../security/rule-descriptions.cjs').descriptionByRule,
};

// Messages carry per-site detail, so a rule without a registered description is summarized by its first sentence.
function shortDescription(pillar, ruleId, message) {
  return descriptionsByPillar[pillar]?.()[ruleId] ?? message.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? message;
}

function rulesFor(pillar, findings) {
  const rules = new Map();
  for (const { ruleId, message } of findings) {
    if (rules.has(ruleId)) continue;
    rules.set(ruleId, {
      id: ruleId,
      shortDescription: { text: shortDescription(pillar, ruleId, message) },
      helpUri: `${documentationUrl}#${ruleId}`,
    });
  }
  return [...rules.values()];
}

function resultFor(pillar, root, finding) {
  return {
    ruleId: finding.ruleId,
    level: findingLevel(pillar, finding),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: repositoryPath(root, finding.file), uriBaseId: '%SRCROOT%' },
          region: { startLine: finding.line ?? 1, startColumn: finding.column ?? 1 },
        },
      },
    ],
    partialFingerprints: { [fingerprintKey]: finding.id },
    ...(finding.impactLevel ? { properties: { impact: finding.impactLevel } } : {}),
  };
}

function runFor({ pillar, root, report }) {
  const findings = report.findings;
  return {
    tool: { driver: { name: 'loadwise', informationUri: documentationUrl, rules: rulesFor(pillar, findings) } },
    automationDetails: { id: `loadwise/${pillar}/` },
    results: findings.map((finding) => resultFor(pillar, root, finding)),
  };
}

// One run per pillar that produced a report, so code scanning keeps their alerts apart.
function formatSarif(entries) {
  const runs = entries.filter(({ report }) => report).map(runFor);
  return JSON.stringify({ version: '2.1.0', $schema: sarifSchema, runs }, null, 2);
}

module.exports = { formatSarif };
