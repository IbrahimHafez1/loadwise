// @ts-check
'use strict';

// Findings with the same reason print it once above their locations instead of repeating it for each one. Groups keep
// the order of their first item, so a ranked report stays ranked by its first finding.
function groupByReason(items, reasonOf) {
  const groups = new Map();
  for (const item of items) {
    const key = JSON.stringify(reasonOf(item));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

// A report finding's reason: its rule, impact, message and any contextual reason.
const findingReason = (finding) => [
  finding.ruleId,
  finding.impactLevel,
  finding.message,
  finding.contextualReason ?? '',
];

module.exports = { findingReason, groupByReason };
