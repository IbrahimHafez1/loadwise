// @ts-check
'use strict';

// How much a finding matters, shared by every pillar so one `--min-impact` flag means the same everywhere.
//
// Each pillar keeps its own table in its rule-ids.cjs: `impactByRule`, a plain object from rule id to one of
// `impactLevels`. A new pillar (security, for one) registers its ids by exporting the same shape and calling
// `annotateImpact` on its findings. The finding field is `impactLevel`; `impact` is already the before/after estimate.
const { hotPathOrder } = require('./hot-path.cjs');

const impactLevels = ['low', 'medium', 'high', 'critical'];

function impactRank(level) {
  return impactLevels.indexOf(level);
}

// Returns the validated level, or undefined when the flag was not given.
function parseMinImpact(value) {
  if (value === undefined) return undefined;
  if (impactRank(value) === -1) throw new Error(`--min-impact must be one of ${impactLevels.join(', ')}.`);
  return value;
}

function annotateImpact(findings, impactByRule) {
  for (const finding of findings) finding.impactLevel = impactByRule[finding.ruleId];
  return findings;
}

function filterMinImpact(findings, minImpact) {
  if (minImpact === undefined) return findings;
  return findings.filter((finding) => impactRank(finding.impactLevel) >= impactRank(minImpact));
}

// Most severe first within each run of findings from one file, then the hottest code (request before job before
// script before test); equal ranks keep their current order, and the files keep theirs.
function sortByImpactWithinFiles(findings) {
  const sorted = [];
  let start = 0;
  while (start < findings.length) {
    let end = start;
    while (end < findings.length && findings[end].file === findings[start].file) end++;
    const run = findings.slice(start, end);
    run.sort(
      (left, right) =>
        impactRank(right.impactLevel) - impactRank(left.impactLevel) || hotPathOrder(left) - hotPathOrder(right),
    );
    sorted.push(...run);
    start = end;
  }
  return sorted;
}

module.exports = { impactLevels, impactRank, parseMinImpact, annotateImpact, filterMinImpact, sortByImpactWithinFiles };
